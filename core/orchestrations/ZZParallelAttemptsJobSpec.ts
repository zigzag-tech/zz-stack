import { ZZJobSpec, sleep } from "../microworkers/ZZJobSpec";
import { z } from "zod";
import { ZZWorkerDef } from "../microworkers/ZZWorker";
import { UnknownTMap } from "../microworkers/StreamDefSet";

type TriggerCheckContext = {
  totalTimeElapsed: number;
  attemptStats: {
    name: string;
    attemptTimeElapsed: number;
    resolved: boolean;
  }[];
};

interface ParallelAttempt<
  ParentDef extends ZZJobSpec<unknown, UnknownTMap, UnknownTMap, unknown>
> {
  def: ParentDef;
  triggerCondition: (c: TriggerCheckContext) => boolean;
}

export function genParallelAttempt<
  ParentDef extends ZZJobSpec<unknown, UnknownTMap, UnknownTMap, unknown>
>(
  def: ParentDef,
  config: Omit<ParallelAttempt<ParentDef>, "def">
): ParallelAttempt<ParentDef> {
  return {
    def,
    ...config,
  };
}

export class ZZParallelAttemptWorkerDef<
  MaJobSpecDef extends ZZJobSpec<unknown, UnknownTMap, UnknownTMap, unknown>,
  P = z.infer<MaJobSpecDef["jobParamsDef"]>
> extends ZZWorkerDef<MaJobSpecDef, {}> {
  constructor({
    attempts,
    globalTimeoutCondition,
    transformCombinedOutput,
    jobSpec,
  }: {
    jobSpec: ZZJobSpec<MaJobSpecDef>;
    globalTimeoutCondition?: (c: TriggerCheckContext) => boolean;
    transformCombinedOutput: (
      results: {
        result?: any;
        timedout: boolean;
        error: boolean;
        name: string;
      }[]
    ) => Promise<O> | O;
    attempts: ParallelAttempt<MaJobSpecDef>[];
  }) {
    super({
      jobSpec,
      processor: async ({ logger, jobParams, spawnJob, jobId }) => {
        const genRetryFunction = ({
          def: attemptDef,
        }: ParallelAttempt<MaJobSpecDef>) => {
          const fn = async () => {
            const childJobId = `${jobId}/${attemptDef.name}`;
            const { nextOutput } = await spawnJob({
              jobId: childJobId,
              def: attemptDef as JobSpecDef<P, O, any, StreamI, any>,
              jobParams: jobParams as P,
            });

            const o = await nextOutput();
            if (!o) {
              throw new Error("no output");
            }

            const result = o;

            return {
              resolved: true as const,
              error: false as const,
              result,
            };
          };
          return fn;
        };

        const contexts: TriggerCheckContext[] = [];
        const restAttempts = [...attempts];
        const running: {
          promise: ReturnType<ReturnType<typeof genRetryFunction>>;
          name: string;
          timeStarted: number;
          isResolved: () => boolean;
          getResult: () => O | undefined;
        }[] = [];

        const time = Date.now();
        const genCtx = () => {
          const ctx: TriggerCheckContext = {
            totalTimeElapsed: Date.now() - time,
            attemptStats: running.map((r) => ({
              name: r.name,
              attemptTimeElapsed: Date.now() - r.timeStarted,
              resolved: r.isResolved(),
            })),
          };
          contexts.push(ctx);
          return ctx;
        };

        if (!globalTimeoutCondition) {
          globalTimeoutCondition = (c) => {
            return c.totalTimeElapsed > 1000 * 60 * 15; // 15 minutes by default
          };
        }

        let cont = genCtx();

        do {
          // check head and see if is met for the first one
          let nextAttempt = restAttempts[0];
          if (!nextAttempt) {
            continue;
          }
          cont = genCtx();
          if (nextAttempt.triggerCondition(cont)) {
            nextAttempt = restAttempts.shift()!;
            const { setResolved, isResolved } = genResolvedTracker();

            let result: O | undefined = undefined;
            const fn = genRetryFunction(nextAttempt);
            logger.info(`Started attempt ${nextAttempt.def.name}.`);
            running.push({
              promise: fn()
                .then((r) => {
                  setResolved();
                  result = r.result;
                  return r;
                })
                .catch((e) => {
                  throw e;
                }),
              name: nextAttempt.def.name,
              timeStarted: Date.now(),
              isResolved: () => isResolved(),
              getResult: () => result,
            });
          }

          await sleep(200);
        } while (restAttempts.length > 0);

        await Promise.all(running.map((r) => r.promise));

        const raws = running.map((r) => {
          return {
            result: r.getResult(),
            timedout: false,
            error: false,
            name: r.name,
          };
        });

        return await transformCombinedOutput(raws);
      },
    });
  }
}

const genResolvedTracker = () => {
  let resolved = false;
  return {
    setResolved: () => {
      resolved = true;
    },
    isResolved: () => resolved,
  };
};

export const genTimeoutPromise = async (timeout: number) => {
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, timeout);
  });
  await timeoutPromise;
  return { timeout: true as const, error: false as const };
};
