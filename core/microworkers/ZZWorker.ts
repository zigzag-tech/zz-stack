import _ from "lodash";
import { Worker, Job } from "bullmq";
import { getLogger } from "../utils/createWorkerLogger";
import { ZZJob, ZZProcessor } from "./ZZJob";
import { ZZJobSpec } from "./ZZJobSpec";
import { ZZEnv } from "./ZZEnv";
import { IStorageProvider } from "../storage/cloudStorage";
import { z } from "zod";

export const JOB_ALIVE_TIMEOUT = 1000 * 60 * 10;

export type ZZWorkerDefParams<
  P,
  IMap,
  OMap,
  TProgress = never,
  WP extends object = {}
> = {
  concurrency?: number;
  jobSpec: ZZJobSpec<P, IMap, OMap, TProgress>;
  processor: ZZProcessor<ZZJobSpec<P, IMap, OMap, TProgress>, WP>;
  instanceParamsDef?: z.ZodType<WP>;
};

export class ZZWorkerDef<
  P,
  IMap,
  OMap,
  TProgress = never,
  WP extends object = {}
> {
  public readonly jobSpec: ZZJobSpec<P, IMap, OMap, TProgress>;
  public readonly instanceParamsDef?: z.ZodType<WP | {}>;
  public readonly processor: ZZProcessor<
    ZZJobSpec<P, IMap, OMap, TProgress>,
    WP
  >;

  constructor({
    jobSpec,
    processor,
    instanceParamsDef,
  }: ZZWorkerDefParams<P, IMap, OMap, TProgress, WP>) {
    this.jobSpec = jobSpec;
    this.instanceParamsDef = instanceParamsDef || z.object({});
    this.processor = processor;
  }

  public async startWorker(p?: { concurrency?: number; instanceParams?: WP }) {
    const { concurrency, instanceParams } = p || {};

    const worker = new ZZWorker<P, IMap, OMap, TProgress, WP>({
      def: this,
      concurrency,
      instanceParams: instanceParams || ({} as WP),
    });
    // this.workers.push(worker);
    await worker.waitUntilReady();
    return worker;
  }
}

export class ZZWorker<
  P,
  IMap,
  OMap,
  TProgress = never,
  WP extends object = {}
> {
  public readonly jobSpec: ZZJobSpec<P, IMap, OMap, TProgress>;
  protected readonly zzEnv: ZZEnv;
  protected readonly storageProvider?: IStorageProvider;

  private readonly bullMQWorker: Worker<
    {
      jobParams: P;
    },
    void
  >;

  public readonly instanceParams?: WP;
  public readonly workerName: string;
  public readonly def: ZZWorkerDef<P, IMap, OMap, TProgress, WP>;
  protected readonly logger: ReturnType<typeof getLogger>;

  constructor({
    instanceParams,
    def,
    workerName,
    concurrency = 3,
  }: {
    def: ZZWorkerDef<P, IMap, OMap, TProgress, WP>;
    instanceParams?: WP;
    workerName?: string;
    concurrency?: number;
  }) {
    // if worker name is not provided, use random string

    this.jobSpec = def.jobSpec;
    this.zzEnv = def.jobSpec.zzEnv;
    this.instanceParams = instanceParams;
    this.def = def;

    const workerOptions = {
      autorun: false,
      concurrency,
      connection: this.zzEnv.redisConfig,
    };

    this.workerName =
      workerName || "wkr:" + `${this.zzEnv.projectId}/${this.def.jobSpec.name}`;
    this.logger = getLogger(`wkr:${this.workerName}`);

    const mergedWorkerOptions = _.merge({}, workerOptions);

    this.bullMQWorker = new Worker<{ jobParams: P }, void, string>(
      `${this.zzEnv.projectId}/${this.jobSpec.name}`,
      async (job, token) => {
        const zzJ = new ZZJob({
          bullMQJob: job,
          bullMQToken: token,
          logger: this.logger,
          jobSpec: this.jobSpec,
          jobParams: job.data.jobParams,
          workerInstanceParams: this.instanceParams,
          storageProvider: this.zzEnv.storageProvider,
          workerName: this.workerName,
        });

        return await zzJ.beginProcessing(this.def.processor.bind(zzJ) as any);
      },
      mergedWorkerOptions
    );

    // Setup event listeners
    this.bullMQWorker.on("active", (job: Job) => {});

    this.bullMQWorker.on("failed", async (job, error: Error) => {
      this.logger.error(`JOB FAILED: ${job?.id}, ${error}`);
    });

    this.bullMQWorker.on("error", (err) => {
      const errStr = String(err);
      if (!errStr.includes("Missing lock for job")) {
        this.logger.error(`ERROR: ${err}`);
      }
    });

    this.bullMQWorker.on(
      "progress",
      (job: Job, progress: number | object) => {}
    );

    this.bullMQWorker.on("completed", async (job: Job) => {
      this.logger.info(`JOB COMPLETED: ${job.id}`);
    });

    this.bullMQWorker.run();
    this.bullMQWorker.waitUntilReady().then(() => {
      this.logger.info(`${this.bullMQWorker.name} worker started.`);
    });
  }

  public async waitUntilReady() {
    await this.bullMQWorker.waitUntilReady();
  }
}
