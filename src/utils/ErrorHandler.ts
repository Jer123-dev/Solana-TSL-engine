import logger from "./Logger";

export function handleError(error: any, context = "") {
  logger.error(`Error${context ? ` in ${context}` : ""}: ${error.stack || error}`);
}
