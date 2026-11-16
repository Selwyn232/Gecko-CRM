/**
 * Fouten die bewust naar de client gaan. Elke fout heeft een stabiele `code`
 * (Engels, voor programma's) en een `message` (Nederlands, voor mensen).
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code = "unauthorized", message = "Niet ingelogd") =>
  new AppError(401, code, message);
export const forbidden = (code = "forbidden", message = "Geen toegang") => new AppError(403, code, message);
export const notFound = (entity: string) => new AppError(404, "not_found", `${entity} niet gevonden`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
