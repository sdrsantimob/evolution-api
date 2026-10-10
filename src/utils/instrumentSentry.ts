import { configService, Sentry as SentryConfig } from '@config/env.config';
import * as Sentry from '@sentry/node';

import { scrubRequest } from './sentryScrub';

const sentryConfig = configService.get<SentryConfig>('SENTRY');

if (sentryConfig.DSN) {
  Sentry.init({
    dsn: sentryConfig.DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
    // [WA-37] Nenhum evento sai com o corpo da requisição, a consulta, cookies ou a chave de acesso.
    sendDefaultPii: false,
    beforeSend: (event) => scrubRequest(event),
    beforeSendTransaction: (event) => scrubRequest(event),
  });
}
