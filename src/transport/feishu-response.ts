/**
 * Some Feishu SDK methods return a `{code,msg,data}` envelope, while the
 * file/image upload endpoints return the bare `data` object. Normalize both.
 *
 * @module dsh-caduceus/transport/feishu-response
 */
import { FeishuApiError } from './types.js';

export function unwrapFeishuData<T extends object>(
  response: unknown,
  operation: string,
): T {
  if (typeof response !== 'object' || response === null) {
    throw new FeishuApiError(`feishu ${operation} returned no data`, -1);
  }
  const record = response as { readonly code?: unknown; readonly msg?: unknown; readonly data?: unknown };
  if (typeof record.code === 'number') {
    if (record.code !== 0) {
      throw new FeishuApiError(
        `feishu ${operation} failed (code ${record.code}): ${typeof record.msg === 'string' ? record.msg : 'unknown error'}`,
        record.code,
      );
    }
    const data = record.data;
    if (typeof data !== 'object' || data === null) {
      throw new FeishuApiError(`feishu ${operation} returned no data`, -1);
    }
    return data as T;
  }
  // Bare data shape (file/image upload endpoints in the installed SDK).
  return record as T;
}
