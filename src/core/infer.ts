import type { z, ZodType } from "zod";
import type { CollectionConfig, Field } from "./types.ts";

/** Flattens intersections so editors show the resolved record shape on hover. */
export type Prettify<T> = { [K in keyof T]: T[K] };

type Many<F, T> = F extends { hasMany: true } ? T[] : T;

/** Stored value of a field as the store returns it (PB zero values, never null for scalars). */
export type FieldValue<F extends Field> = F extends { type: "json"; schema: infer S extends ZodType }
  // PB reads an empty json column as null, so only a required one is guaranteed to hold the schema's shape.
  ? F extends { required: true } ? z.output<S> : z.output<S> | null
  : F extends { schema: infer S extends ZodType } ? z.output<S>
  : F extends { type: "text" | "email" | "date" } ? string
  : F extends { type: "number" } ? number
  : F extends { type: "checkbox" } ? boolean
  : F extends { type: "select"; options: readonly (infer O)[] } ? Many<F, O>
  : F extends { type: "relationship" } ? Many<F, string>
  : F extends { type: "file" } ? FileMany<F, string>
  : unknown;

/** A file field holds a list only when maxSelect > 1. */
type FileMany<F, T> = F extends { maxSelect: infer N extends number } ? (N extends 0 | 1 ? T : T[]) : T;

/** What a write takes for a field: file fields also accept uploads (File) and mixes with stored names. */
export type InputValue<F extends Field> = F extends { type: "file" } ? FileMany<F, string | File> | (string | File)[]
  : FieldValue<F>;

type Stored<Fs extends readonly Field[]> = Exclude<Fs[number], { virtual: true }>;

type AuthPart<C extends CollectionConfig> = C["auth"] extends false | undefined ? object
  : { email: string; verified: boolean };

/** A record of C as read: id, timestamps, auth columns and every declared field. */
export type InferRecord<C extends CollectionConfig> = Prettify<
  & { id: string; created: string; updated: string }
  & AuthPart<C>
  & { [F in C["fields"][number] as F["name"]]: FieldValue<F> }
>;

type RequiredKeys<Fs extends readonly Field[]> = Extract<Stored<Fs>, { required: true }>["name"];

/** What create accepts: required fields required, the rest optional; auth collections take password input. */
export type InferInput<C extends CollectionConfig> = Prettify<
  & { [F in Stored<C["fields"]> as F["name"] extends RequiredKeys<C["fields"]> ? F["name"] : never]: InputValue<F> }
  & { [F in Stored<C["fields"]> as F["name"] extends RequiredKeys<C["fields"]> ? never : F["name"]]?: InputValue<F> }
  & (C["auth"] extends false | undefined ? object
    : { email?: string; verified?: boolean; password?: string; passwordConfirm?: string; oldPassword?: string })
>;
