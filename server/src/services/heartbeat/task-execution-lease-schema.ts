import {z} from 'zod';
export const taskExecutionLeaseSchema=z.object({
 issueId:z.string().uuid(),idempotencyKey:z.string().regex(/^[a-zA-Z0-9:_-]{8,160}$/),
 headSha:z.string().regex(/^[a-f0-9]{40}$/),expectedControlHash:z.string().regex(/^[a-f0-9]{64}$/),
 expectedModel:z.string().min(1).max(240),scopeDescription:z.string().min(1).max(100_000),
 profile:z.object({adapterConfig:z.object({command:z.string().startsWith('/').max(4096),extraArgs:z.array(z.string().max(32_000)).max(200)}).strict()}).strict(),
 expiresAt:z.string().datetime(),
}).strict();
