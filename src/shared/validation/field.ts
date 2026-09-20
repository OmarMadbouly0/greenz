import { z } from "zod";

export function requiredString(label: string, max: number, min = 1) {
  return z
    .string(`${label} is required.`)
    .trim()
    .min(
      min,
      min === 1
        ? `${label} is required.`
        : `${label} must be at least ${min} characters.`,
    )
    .max(max, `${label} must not exceed ${max} characters.`);
}

export function optionalText(label: string, max: number) {
  return z
    .string(`${label} must be a string.`)
    .trim()
    .max(max, `${label} must not exceed ${max} characters.`)
    .optional();
}
export function requiredInt(label: string, min: number, max: number) {
  return z
    .number(`${label} is required.`)
    .int(`${label} must be an integer.`)
    .min(
      min,
      min === 0
        ? `${label} must not be negative.`
        : `${label} must be at least ${min}.`,
    )
    .max(max, `${label} must not exceed ${max}.`);
}

export function requiredNumber(label: string, min: number, max: number) {
  return z
    .number(`${label} is required.`)
    .min(
      min,
      min === 0
        ? `${label} must not be negative.`
        : `${label} must be at least ${min}.`,
    )
    .max(max, `${label} must not exceed ${max}.`);
}

export function requiredId(label: string) {
  return z
    .number(`${label} is required.`)
    .int(`${label} must be an integer.`)
    .positive(`${label} must be a positive number.`);
}

export function requiredEmail() {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.email("Email must be a valid email address."),
  );
}
export function optionalId(label: string) {
  return z
    .number(`${label} must be a number.`)
    .int(`${label} must be an integer.`)
    .positive(`${label} must be a positive number.`)
    .optional();
}

export function optionalNumber(label: string, min: number, max: number) {
  return z
    .number(`${label} must be a number.`)
    .min(
      min,
      min === 0
        ? `${label} must not be negative.`
        : `${label} must be at least ${min}.`,
    )
    .max(max, `${label} must not exceed ${max}.`)
    .nullish();
}
