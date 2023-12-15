import { Job, FlowJob, FlowProducer, WaitingChildrenError } from "bullmq";
import { getLogger } from "../utils/createWorkerLogger";
import Redis from "ioredis";
import {
  PubSubFactory,
  sequentialInputFactory,
  sequentialOutputFactory,
} from "../realtime/mq-pub-sub";
import { Observable } from "rxjs";
import { JOB_ALIVE_TIMEOUT, sleep } from "./ZZWorker";
import {
  IStorageProvider,
  getPublicCdnUrl,
  saveLargeFilesToStorage,
} from "../storage/cloudStorage";
import { isBinaryLikeObject } from "../utils/isBinaryLikeObject";
import { TEMP_DIR, getTempPathByJobId } from "../storage/temp-dirs";
import fs from "fs";
import { ensurePathExists } from "../storage/ensurePathExists";
import path from "path";
import { ensureJobDependencies, getJobLogByIdAndType } from "../db/knexConn";
import longStringTruncator from "../utils/longStringTruncator";
import { ZZPipe } from "./ZZPipe";
import { PipeDef, ZZEnv } from "./PipeRegistry";

export type ZZProcessor<P, O, StreamI = never> = ZZJob<
  P,
  O,
  StreamI
>["processor"];
export type ZZProcessorParams<P, O, StreamI = never> = Parameters<
  ZZProcessor<P, O, StreamI>
>[0];
export type ZZProcessorReturn<P, O, StreamI = never> = ReturnType<
  ZZProcessor<P, O, StreamI>
>;
export class ZZJob<P, O, StreamI = never> {
  public readonly bullMQJob: Job<{ params: P }, O>;
  public readonly _bullMQToken?: string;
  params: P;
  inputObservable: Observable<StreamI>;
  logger: ReturnType<typeof getLogger>;

  public async aliveLoop(retVal: O) {
    const redis = new Redis();

    let lastTimeJobAlive = Date.now();
    while (Date.now() - lastTimeJobAlive < JOB_ALIVE_TIMEOUT) {
      lastTimeJobAlive = parseInt(
        (await redis.get(`last-time-job-alive-${this.bullMQJob.id}`)) || "0"
      );
      await sleep(1000 * 60);
    }
    this.logger.info(
      `Job with ${this.bullMQJob.id} id expired. Marking as complete.`
    );
    await this.bullMQJob.moveToCompleted(retVal, this._bullMQToken!);
    return retVal;
  }
  nextInput: () => Promise<StreamI>;
  emitOutput: (o: O) => Promise<void>;

  workingDirToBeUploadedToCloudStorage: string;

  storageProvider?: IStorageProvider;
  flowProducer: FlowProducer;
  processor: (j: ZZJob<P, O, StreamI>) => Promise<O>;
  pipe: ZZPipe<P, O, StreamI>;
  readonly def: PipeDef<P, O, StreamI>;
  readonly zzEnv: ZZEnv;

  constructor(p: {
    bullMQJob: Job<{ params: P }, O, string>;
    bullMQToken?: string;
    logger: ReturnType<typeof getLogger>;
    params: P;
    flowProducer: FlowProducer;
    storageProvider?: IStorageProvider;
    pipe: ZZPipe<P, O, StreamI>;
    processor: ZZJob<P, O, StreamI>["processor"];
  }) {
    this.bullMQJob = p.bullMQJob;
    this._bullMQToken = p.bullMQToken;
    this.params = p.params;
    this.logger = p.logger;
    this.flowProducer = p.flowProducer;
    this.storageProvider = p.storageProvider;
    this.def = p.pipe.def;
    this.zzEnv = p.pipe.zzEnv;
    this.pipe = p.pipe;
    this.processor = p.processor;

    const workingDir = getTempPathByJobId(this.bullMQJob.id!);

    this.workingDirToBeUploadedToCloudStorage = workingDir;

    const pubSubFactory = new PubSubFactory<StreamI, O>(
      {
        projectId: this.zzEnv.projectId,
      },
      this.zzEnv.redisConfig,
      this.def.name + "::" + this.bullMQJob.id!
    );

    const { nextInput, inputObservable } = sequentialInputFactory<StreamI>({
      pubSubFactory: pubSubFactory,
    });
    this.nextInput = nextInput;
    this.inputObservable = inputObservable;

    const { emitOutput } = sequentialOutputFactory<O>({
      pubSubFactory: pubSubFactory,
    });

    this.emitOutput = emitOutput;
  }

  public async beginProcessing(): Promise<O> {
    const savedResult = await getJobLogByIdAndType<O>({
      jobType: this.def.name,
      jobId: this.bullMQJob.id!,
      projectId: this.zzEnv.projectId,
      dbConn: this.zzEnv.db,
      jobStatus: "completed",
    });
    const job = this.bullMQJob;
    const logger = this.logger;
    const projectId = this.zzEnv.projectId;

    if (savedResult) {
      this.logger.info(
        `Skipping job with ID: ${job.id}, ${this.bullMQJob.queueName} ` +
          `${JSON.stringify(this.bullMQJob.data, longStringTruncator)}`,
        +`${JSON.stringify(await job.getChildrenValues(), longStringTruncator)}`
      );
      return savedResult.job_data;
    } else {
      logger.info(
        `Picked up job with ID: ${job.id}, ${job.queueName} ` +
          `${JSON.stringify(job.data, longStringTruncator)}`,
        +`${JSON.stringify(await job.getChildrenValues(), longStringTruncator)}`
      );

      try {
        await _upsertAndMergeJobLogByIdAndType({
          projectId,
          jobType: this.def.name,
          jobId: job.id!,
          dbConn: this.zzEnv.db,
          jobStatus: "active",
        });
        if (job.opts.parent?.id) {
          await ensureJobDependencies({
            parentJobId: job.opts.parent.id,
            childJobId: job.id!,
            dbConn: this.zzEnv.db,
            projectId,
          });
        }

        const processedR = await this.processor(this);

        // await job.updateProgress(processedR as object);
        await _upsertAndMergeJobLogByIdAndType({
          projectId,
          jobType: this.def.name,
          jobId: job.id!,
          dbConn: this.zzEnv.db,
          jobStatus: "completed",
        });
        return processedR;
      } catch (e: any) {
        if (e instanceof WaitingChildrenError) {
          await _upsertAndMergeJobLogByIdAndType({
            projectId,
            jobType: this.def.name,
            jobId: job.id!,
            dbConn: this.zzEnv.db,
            jobStatus: "waiting_children",
          });
        } else {
          await _upsertAndMergeJobLogByIdAndType({
            projectId,
            jobType: this.def.name,
            jobId: job.id!,
            dbConn: this.zzEnv.db,
            jobStatus: "failed",
          });
        }
        throw e;
      }
    }
  }

  public async spawnChildJobsToWaitOn<CI, CO>(
    childJob_: FlowJob & {
      data: CI;
    }
  ) {
    childJob_.opts = {
      ...childJob_.opts,
      parent: {
        id: this.bullMQJob.id!,
        queue: this.bullMQJob.queueQualifiedName,
      },
    };

    return this.spawnJob<CI, CO>(childJob_);
  }

  public async spawnJob<CI, CO>(
    newJob_: FlowJob & {
      data: CI;
    }
  ) {
    newJob_.data = {
      params: newJob_.data,
    };

    newJob_.opts = {
      ...newJob_.opts,
      jobId: newJob_.name,
    };

    const pubsubForChild = new PubSubFactory<CI, CO>(
      {
        projectId: this.zzEnv.projectId,
      },
      this.zzEnv.redisConfig,
      newJob_.queueName + "::" + newJob_.name
    );
    await this.flowProducer.add(newJob_);
    return {
      subToOutput: pubsubForChild.subForJobOutput.bind(pubsubForChild),
    };
  }

  public async saveToTextFile({
    relativePath,
    data,
  }: {
    relativePath: string;
    data: string;
  }) {
    await ensurePathExists(this.workingDirToBeUploadedToCloudStorage);
    fs.writeFileSync(
      path.join(this.workingDirToBeUploadedToCloudStorage, relativePath),
      data
    );
  }

  public async update({ incrementalData }: { incrementalData?: any }) {
    let jobData: any;

    if (this.storageProvider) {
      const { newObj, largeFilesToSave } = identifyLargeFiles(
        incrementalData,
        `${this.zzEnv.projectId}/jobs/${this.bullMQJob.id!}/large-values`
      );
      await saveLargeFilesToStorage(largeFilesToSave, this.storageProvider);
      jobData = newObj;
    } else {
      jobData = incrementalData;
    }
    await _upsertAndMergeJobLogByIdAndType({
      projectId: this.zzEnv.projectId,
      jobType: this.def.name,
      jobId: this.bullMQJob.id!,
      jobData,
      dbConn: this.zzEnv.db,
    });
  }

  private getLargeValueCdnUrl<T extends object>(key: keyof T, obj: T) {
    if (!this.storageProvider) {
      throw new Error("storageProvider is not provided");
    }
    if (!this.storageProvider.getPublicUrl) {
      throw new Error("storageProvider.getPublicUrl is not provided");
    }
    const { largeFilesToSave } = identifyLargeFiles(obj);
    const found = largeFilesToSave.find((x) => x.path === key);
    if (!found) {
      console.error("Available keys: ", Object.keys(obj));
      throw new Error(`Cannot find ${String(key)} in largeFilesToSave`);
    } else {
      return getPublicCdnUrl({
        projectId: this.zzEnv.projectId,
        jobId: this.bullMQJob.id!,
        key: String(key),
        storageProvider: this.storageProvider,
      });
    }
  }

  private async ensureLocalSourceFileExists(filePath: string) {
    try {
      fs.accessSync(filePath);
    } catch (error) {
      if (this.storageProvider) {
        ensurePathExists(filePath);
        const gcsFileName = filePath
          .split(`${TEMP_DIR}/`)[1]
          .replace(/_/g, "/");
        await this.storageProvider.downloadFromStorage({
          filePath: gcsFileName,
          destination: filePath,
        });
      }
    }
  }
}

const OBJ_REF_VALUE = `__zz_obj_ref__`;
const LARGE_VALUE_THRESHOLD = 1024 * 10;

export const identifyLargeFiles = (
  obj: any,
  path = ""
): { newObj: any; largeFilesToSave: { path: string; value: any }[] } => {
  if (obj === null || typeof obj !== "object") {
    return { newObj: obj, largeFilesToSave: [] };
  }
  const newObj: any = Array.isArray(obj) ? [] : {};
  const largeFilesToSave: { path: string; value: any }[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}/${key}` : key;
    if (typeof value === "string" && value.length > LARGE_VALUE_THRESHOLD) {
      largeFilesToSave.push({ path: currentPath, value });
      newObj[key] = OBJ_REF_VALUE;
    } else if (isBinaryLikeObject(value)) {
      largeFilesToSave.push({ path: currentPath, value });
      newObj[key] = OBJ_REF_VALUE;
    } else if (typeof value === "object") {
      const result = identifyLargeFiles(value, currentPath);
      newObj[key] = result.newObj;
      largeFilesToSave.push(...result.largeFilesToSave);
    } else {
      newObj[key] = value;
    }
  }
  return { newObj, largeFilesToSave };
};
