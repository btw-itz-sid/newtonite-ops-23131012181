// Small helpers that keep route handlers thin: parse input, call a service, map errors.
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, badRequest, notFound } from "./errors";

type RouteContext<P> = { params: Promise<P> };

/** Wraps a route handler so any thrown AppError / unexpected error becomes a JSON response. */
export function route<P = Record<string, never>>(
  handler: (req: Request, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteContext<P>): Promise<Response> => {
    try {
      return await handler(req, await ctx.params);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error(err);
  return json({ error: { code: "INTERNAL", message: "Something went wrong" } }, 500);
}

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(body, { status, headers });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be valid JSON");
  }
  return validate(schema, raw);
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  return validate(schema, params);
}

function validate<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest("VALIDATION_ERROR", details[0]?.message ?? "Invalid request", details);
  }
  return result.data;
}

/** A malformed id can't match any row; answer 404 like any other missing item. */
export function parseId(id: string, what = "Item"): string {
  if (!z.uuid().safeParse(id).success) throw notFound(what);
  return id;
}
