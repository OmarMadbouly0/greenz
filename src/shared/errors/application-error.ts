export class ApplicationError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export class InvalidRequestError extends ApplicationError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class UnauthorizedError extends ApplicationError {
  constructor(message: string) {
    super(message, 401);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class InvalidTokenError extends ApplicationError {
  constructor(message: string) {
    super(message, 401);
  }
}
