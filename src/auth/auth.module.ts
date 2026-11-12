import { Global, Module } from '@nestjs/common';
import { ProviderAuthGuard } from './provider-auth.guard.ts';
import { NoopProviderIdentity, ProviderIdentityPort } from './provider-identity.port.ts';

/**
 * Authentication extension point. The guard is registered globally in AppModule
 * (APP_GUARD); here we bind the no-op identity resolver. Swap the port binding to
 * enable real OIDC auth without touching controllers.
 */
@Global()
@Module({
  providers: [{ provide: ProviderIdentityPort, useClass: NoopProviderIdentity }, ProviderAuthGuard],
  exports: [ProviderIdentityPort, ProviderAuthGuard],
})
export class AuthModule {}
