export class ReviewQueueRuntimeError extends Error {
  constructor(
    readonly category: string,
    message: string,
  ) {
    super(message);
  }
}
