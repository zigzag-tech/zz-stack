import { z } from "zod";

export type InferStreamSetType<T> = T extends StreamDefSet<infer TMap>
  ? {
      [K in keyof TMap]: TMap[K];
    }
  : never;

export type UnknownTMap = Record<string | number | symbol, unknown>;

export class StreamDefSet<TMap extends UnknownTMap> {
  private defs: Record<keyof TMap, z.ZodType<TMap[keyof TMap]>>;

  constructor({
    defs,
  }: {
    defs: Record<keyof TMap, z.ZodType<TMap[keyof TMap]>>;
  }) {
    this.defs = defs;
  }

  get isSingle() {
    return Object.keys(this.defs).length === 1;
  }

  public getDef = <K extends keyof TMap>(key?: K) => {
    if (!key) {
      const def = this.defs["default" as const];
      return def;
    } else {
      const def = (
        this.defs as Record<keyof TMap, z.ZodType<TMap[keyof TMap]>>
      )[key as keyof TMap[K]] as z.ZodType<TMap[K]>;
      return def;
    }
  };
}