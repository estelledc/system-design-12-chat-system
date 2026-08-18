export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed') {
    super(message, { code: 'invalid_request', status: 400 });
  }
}

export class AuthenticationError extends AppError {
  constructor() {
    super('Authentication required', { code: 'unauthorized', status: 401 });
  }
}

export class NotFoundError extends AppError {
  constructor() {
    super('Resource was not found', { code: 'not_found', status: 404 });
  }
}

export class RequestConflictError extends AppError {
  constructor(message = 'Idempotency key is already bound to different content') {
    super(message, { code: 'idempotency_conflict', status: 409 });
  }
}

export class DependencyError extends AppError {
  constructor(message = 'Dependency operation failed', cause) {
    super(message, { code: 'dependency_unavailable', status: 503, cause });
  }
}
