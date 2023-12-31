import { ZZJobSpec } from "../microworkers/ZZJobSpec";
import { JobSpecDef } from "../microworkers/JobSpecDef";
import { z } from "zod";
import { ZZEnv } from "../microworkers/ZZEnv";

export class RunpodServerlessJobSpec<P extends object, O> extends ZZJobSpec<
  P,
  {
    runpodResult: O;
  }
> {
  protected _endpointId: string;
  protected _runpodApiKey: string;

  constructor({
    serverlessEndpointId,
    runpodApiKey,
    def,
    zzEnv,
  }: {
    serverlessEndpointId: string;
    runpodApiKey: string;
    def: JobSpecDef<P, O>;
    zzEnv: ZZEnv;
  }) {
    super({
      def: def.derive({
        output: z.object({
          runpodResult: def.output,
        }) as any,
      }),
      zzEnv,
      processor: async ({ jobParams, logger }) => {
        const runUrl = `https://api.runpod.ai/v2/${this._endpointId}/run`;

        const respP = await fetch(runUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this._runpodApiKey}`,
          },
          body: JSON.stringify({
            input: jobParams,
          }),
        });

        if (!respP.ok) {
          const errorBody = await respP.text();
          throw new Error(
            `Fetch to runpod serverless endpoint ${this._endpointId} failed with status ${respP.status}: ${errorBody}`
          );
        }
        type RunpodResult = { id: string; delayTime: number } & (
          | {
              status: "IN_PROGRESS";
            }
          | {
              status: "IN_QUEUE";
            }
          | {
              status: "CANCELLED";
            }
          | {
              status: "FAILED";
            }
          | {
              status: "COMPLETED";
              executionTime: number;
              output: O;
            }
        );

        let runpodResult = (await respP.json()) as RunpodResult;

        const statusUrl = `https://api.runpod.ai/v2/${this._endpointId}/status/${runpodResult.id}`;
        while (
          runpodResult.status === "IN_PROGRESS" ||
          runpodResult.status === "IN_QUEUE"
        ) {
          await sleep(1500);
          logger.info(`Checking status for job ${runpodResult.id}...`);
          const respP = await fetch(statusUrl, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this._runpodApiKey}`,
            },
          });

          if (!respP.ok) {
            const errorBody = await respP.text();
            throw new Error(
              `Fetch to runpod serverless endpoint ${this._endpointId} failed with status ${respP.status}: ${errorBody}`
            );
          }

          runpodResult = await respP.json();
          logger.info(
            `Status for job ${runpodResult.id}: ${runpodResult.status}`
          );
        }

        if (runpodResult.status === "CANCELLED") {
          throw new Error(`Runpod job ${runpodResult.id} was cancelled`);
        } else if (runpodResult.status === "FAILED") {
          throw new Error(`Runpod job ${runpodResult.id} failed`);
        }

        // await update({
        //   incrementalData: {
        //     runpodResult: runpodResult.output,
        //     status: "FINISH",
        //   } as Partial<TJobData & { status: "FINISH"; runpodResult: TJobResult }>,
        // });

        return { runpodResult: runpodResult.output };
      },
    });
    this._endpointId = serverlessEndpointId;
    this._runpodApiKey = runpodApiKey;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
