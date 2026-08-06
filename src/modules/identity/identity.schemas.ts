import { z } from 'zod';

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/);

const passwordSchema = z.string().min(12).max(128);

const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const signUpRequestSchema = z.object({
  body: credentialsSchema,
  params: z.object({}),
  query: z.object({}),
});

export const signInRequestSchema = z.object({
  body: credentialsSchema,
  params: z.object({}),
  query: z.object({}),
});

export type SignUpRequest = z.infer<typeof signUpRequestSchema>;
export type SignInRequest = z.infer<typeof signInRequestSchema>;
