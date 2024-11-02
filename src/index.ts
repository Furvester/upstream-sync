import type { EntityClass, EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { Mutex } from "async-mutex";
import {
    type CollectionPageParams,
    type Selector,
    handleJsonApiError,
    injectPageParams,
} from "jsonapi-zod-query";
import type { Logger } from "logforth";
import {
    Connection,
    type ConnectionOptions,
    type Consumer,
    type ConsumerProps,
} from "rabbitmq-client";
import type { z } from "zod";

export type SyncManagerConfig = {
    rabbitmq: ConnectionOptions;
    orm: MikroORM;
    logger: Logger;
    namespace: string;
    apiGatewayUrl: string;
    apiKey: string;
};

export type SyncableEntityClass = EntityClass<{
    id: string;
    upstreamVersion: number;
}>;

export type PreSyncResource = {
    id: string;
    version: number;
};

export type PreSyncDocument<T extends PreSyncResource> = {
    data: T[];
    pageParams: CollectionPageParams;
};

export type MessageEventHandler<T = unknown> = (em: EntityManager, data: T) => Promise<void> | void;

export type MessageEvent<T extends z.ZodTypeAny> = {
    key: string;
    schema: T;
    handler: MessageEventHandler<ReturnType<T["parse"]>>;
};

export type PreSyncHandler<T> = (em: EntityManager, resource: T) => Promise<void> | void;

export type PreSync<TSelector extends Selector<PreSyncDocument<PreSyncResource>>> = {
    basePath: string;
    searchParams?: URLSearchParams;
    selector: TSelector;
    entityClass: SyncableEntityClass;
    create: PreSyncHandler<ReturnType<TSelector>["data"][number]>;
    update: PreSyncHandler<ReturnType<TSelector>["data"][number]>;
};

export type UpstreamEntity = {
    routingKeyPrefix: string;
    events: MessageEvent<z.ZodTypeAny>[];
    preSync: PreSync<Selector<PreSyncDocument<PreSyncResource>>>;
};

export type UpstreamService = {
    serviceName: string;
    entities: UpstreamEntity[];
};

type VersionReference = {
    id: string;
    upstream_version: number;
};

export const createMessageEvent = <T extends z.ZodTypeAny>(
    event: MessageEvent<T>,
): MessageEvent<T> => event;
export const createPreSync = <T extends Selector<PreSyncDocument<PreSyncResource>>>(
    preSync: PreSync<T>,
): PreSync<T> => preSync;
export const createUpstreamEntity = (entity: UpstreamEntity): UpstreamEntity => entity;
export const createUpstreamService = (service: UpstreamService): UpstreamService => service;

export class SyncManager {
    private readonly rabbitmq: Connection;
    private readonly config: SyncManagerConfig;
    private readonly upstreamServices: UpstreamService[] = [];
    private readonly initialSyncMutex: Mutex = new Mutex();

    public constructor(config: SyncManagerConfig) {
        this.config = config;
        this.rabbitmq = new Connection(config.rabbitmq);

        this.rabbitmq.on("error", (error) => {
            config.logger.info("RabbitMQ connection error", { error });
        });

        this.rabbitmq.on("connection", () => {
            config.logger.info("RabbitMQ connection successfully (re)established");
        });
    }

    public addUpstreamService(service: UpstreamService): this {
        this.upstreamServices.push(service);
        return this;
    }

    public async run(): Promise<void> {
        await this.initialSyncMutex.acquire();
        const consumer = this.createConsumer();

        const handleShutdown = async () => {
            await consumer.close();
            await this.rabbitmq.close();
            await this.config.orm.close(true);
        };

        process.on("SIGINT", handleShutdown);
        process.on("SIGTERM", handleShutdown);

        await this.runPreSync();
        this.initialSyncMutex.release();
    }

    private createConsumer(): Consumer {
        const queue = `${this.config.namespace}.upstream-sync`;
        const exchanges: ConsumerProps["exchanges"] = [];
        const queueBindings: ConsumerProps["queueBindings"] = [];
        const eventHandlers = new Map<string, MessageEvent<z.ZodTypeAny>>();

        for (const service of this.upstreamServices) {
            exchanges.push({
                exchange: service.serviceName,
                type: "topic",
            });

            for (const entity of service.entities) {
                queueBindings.push({
                    exchange: service.serviceName,
                    queue,
                    routingKey: `${entity.routingKeyPrefix}.*`,
                });

                for (const event of entity.events) {
                    eventHandlers.set(`${entity.routingKeyPrefix}.${event.key}`, event);
                }
            }
        }

        return this.rabbitmq.createConsumer(
            {
                queue,
                concurrency: 1,
                qos: { prefetchCount: 1 },
                exchanges,
                queueBindings,
            },
            async (message) => {
                await this.initialSyncMutex.waitForUnlock();
                const eventHandler = eventHandlers.get(message.routingKey);

                if (!eventHandler) {
                    this.config.logger.debug(`No event handler found for ${message.routingKey}`);
                    return;
                }

                const result = eventHandler.schema.safeParse(message.body);

                if (!result.success) {
                    this.config.logger.error("Failed to parse message", {
                        issues: result.error.issues,
                    });
                    return;
                }

                await this.config.orm.em.fork().transactional(async (em) => {
                    await eventHandler.handler(em, result.data);
                });
            },
        );
    }

    private async runPreSync(): Promise<void> {
        for (const service of this.upstreamServices) {
            await this.waitReady(`/${service.serviceName}/health`, service.serviceName);

            for (const entity of service.entities) {
                await this.config.orm.em.fork().transactional(async (em) => {
                    await this.preSyncEntity(em, service, entity);
                });

                this.config.logger.info(
                    `Entity with routing key ${entity.routingKeyPrefix} pre-synced`,
                );
            }
        }
    }

    private async preSyncEntity(
        em: EntityManager,
        service: UpstreamService,
        entity: UpstreamEntity,
    ): Promise<void> {
        const versions = new Map(
            (
                await em
                    .createQueryBuilder(entity.preSync.entityClass)
                    .select(["id", "upstreamVersion"])
                    .execute<VersionReference[]>("all", false)
            ).map(({ id, upstream_version }) => [id, upstream_version]),
        );

        const baseUrl = new URL(
            `/${service.serviceName}${entity.preSync.basePath}`,
            this.config.apiGatewayUrl,
        );

        if (entity.preSync.searchParams) {
            baseUrl.search = entity.preSync.searchParams.toString();
        }

        let url: URL | null = baseUrl;

        do {
            const response = await fetch(url, {
                headers: {
                    accept: "application/vnd.api+json",
                    authorization: `Bearer ${this.config.apiKey}`,
                },
            });
            await handleJsonApiError(response);
            const document = entity.preSync.selector(await response.json());

            for (const resource of document.data) {
                const version = versions.get(resource.id);

                if (version === undefined) {
                    await entity.preSync.create(em, resource);
                    continue;
                }

                versions.delete(resource.id);

                if (version === resource.version) {
                    continue;
                }

                await entity.preSync.update(em, resource);
            }

            if (document.pageParams.next) {
                url = new URL(baseUrl);
                injectPageParams(url, document.pageParams.next);
                continue;
            }

            url = null;
        } while (url !== null);

        if (versions.size > 0) {
            await em.nativeDelete(entity.preSync.entityClass, {
                id: { $in: [...versions.keys()] },
            });
        }
    }

    private async waitReady(path: string, serviceName: string): Promise<void> {
        const healthUrl = new URL(path, this.config.apiGatewayUrl);

        for (let i = 0; i < 12; ++i) {
            try {
                const response = await fetch(healthUrl);

                if (response.ok) {
                    return;
                }
            } catch {
                this.config.logger.info("Unable to verify health, backing off");
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }

        throw new Error(`Service "${serviceName}" didn't turn ready within 60 seconds`);
    }
}
