import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CriticalError } from '../../lib/errors.js';
import {
  WechatPayService,
  type WechatCallbackEncryptedResource
} from './wechat-pay.service.js';

const callbackEnvelopeSchema = z.object({
  event_type: z.string(),
  resource: z.object({
    algorithm: z.string(),
    ciphertext: z.string(),
    associated_data: z.string().optional(),
    nonce: z.string()
  })
});

/**
 * Verify WeChat Pay V3 callback RSA-SHA256 signature against exact rawBody bytes,
 * validate the envelope structure, and decrypt AEAD_AES_256_GCM payload when eventType matches.
 */
export function verifyAndDecryptWechatCallback<T>(
  request: FastifyRequest,
  wechatPay: WechatPayService,
  expectedEventType: string
): { eventType: string; payload: T | null } {
  if (typeof request.rawBody !== 'string' || request.rawBody.length === 0) {
    throw new CriticalError('rawBody missing for WeChat Pay V3 callback signature verification');
  }

  wechatPay.verifyCallbackSignature(
    {
      timestamp: request.headers['wechatpay-timestamp'] as string | undefined,
      nonce: request.headers['wechatpay-nonce'] as string | undefined,
      signature: request.headers['wechatpay-signature'] as string | undefined,
      serial: request.headers['wechatpay-serial'] as string | undefined
    },
    request.rawBody
  );

  const envelope = callbackEnvelopeSchema.parse(request.body);
  if (envelope.event_type !== expectedEventType) {
    return { eventType: envelope.event_type, payload: null };
  }

  const payload = wechatPay.decryptCallbackResource<T>(
    envelope.resource as WechatCallbackEncryptedResource
  );
  return { eventType: envelope.event_type, payload };
}
