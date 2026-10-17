// Services throw these; the route wrapper (http.ts) turns them into JSON responses:
// { "error": { "code": "...", "message": "...", "details": ... } }
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Please log in");

export const forbidden = (message: string) => new AppError(403, "FORBIDDEN", message);

export const notFound = (what = "Item") => new AppError(404, "NOT_FOUND", `${what} not found`);

/** 409 = "your view of the data is out of date / someone else won the race". */
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** 422 = "request is well-formed but breaks a business rule". */
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
