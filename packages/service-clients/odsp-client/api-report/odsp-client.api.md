## API Report File for "@fluid-experimental/odsp-client"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts

import { ContainerSchema } from '@fluidframework/fluid-static';
import { IConfigProviderBase } from '@fluidframework/core-interfaces';
import { IFluidContainer } from '@fluidframework/fluid-static';
import type { IMember } from '@fluidframework/fluid-static';
import type { IServiceAudience } from '@fluidframework/fluid-static';
import { ITelemetryBaseLogger } from '@fluidframework/core-interfaces';
import { TokenResponse } from '@fluidframework/odsp-driver-definitions';

// @alpha
export type IOdspAudience = IServiceAudience<OdspMember>;

// @alpha
export interface IOdspTokenProvider {
    fetchStorageToken(siteUrl: string, refresh: boolean): Promise<TokenResponse>;
    fetchWebsocketToken(siteUrl: string, refresh: boolean): Promise<TokenResponse>;
}

// @alpha @sealed
export class OdspClient {
    constructor(properties: OdspClientProps);
    // (undocumented)
    createContainer(containerSchema: ContainerSchema): Promise<{
        container: IFluidContainer;
        services: OdspContainerServices;
    }>;
    // (undocumented)
    getContainer(id: string, containerSchema: ContainerSchema): Promise<{
        container: IFluidContainer;
        services: OdspContainerServices;
    }>;
}

// @alpha (undocumented)
export interface OdspClientProps {
    readonly configProvider?: IConfigProviderBase;
    readonly connection: OdspConnectionConfig;
    readonly logger?: ITelemetryBaseLogger;
}

// @alpha
export interface OdspConnectionConfig {
    driveId: string;
    siteUrl: string;
    tokenProvider: IOdspTokenProvider;
}

// @alpha
export interface OdspContainerServices {
    audience: IOdspAudience;
}

// @alpha
export interface OdspMember extends IMember {
    email: string;
    name: string;
    userId: string;
}

// (No @packageDocumentation comment for this package)

```
