import {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from "apollo-server-plugin-base";
import { GraphQLRequestContext, GraphQLResponse } from "apollo-server-types";
import { KeyValueCache, PrefixingKeyValueCache } from "apollo-server-caching";
import { ValueOrPromise } from "apollo-server-types";
import { CacheHint, CacheScope } from "apollo-cache-control";

import { createHash } from "crypto";

interface ContextualCacheKey {
  sessionMode: SessionMode;
  sessionId?: string | null;
}

interface CacheOptions<TContext = Record<string, any>> {
  // Underlying cache used to save results. Will default to
  // cache passed to the apollo server constructor
  cache?: KeyValueCache;

  // Used when cache scope is PRIVATE. This should return the sessionId of the current user session
  // if any.
  sessionId?(
    requestContext: GraphQLRequestContext<TContext>
  ): ValueOrPromise<string | null>;

  // custom cache key for each cached response
  cacheKey(
    requestContext: GraphQLRequestContext<TContext>
  ): ValueOrPromise<Record<string, any> & ContextualCacheKey>;

  // If this hook is defined and returns false, the plugin will not read
  // responses from the cache.
  shouldReadFromCache?(
    requestContext: GraphQLRequestContext<TContext>
  ): ValueOrPromise<boolean>;

  // If this hook is defined and returns false, the plugin will not write the
  // response to the cache.
  shouldWriteToCache?(
    requestContext: GraphQLRequestContext<TContext>
  ): ValueOrPromise<boolean>;
}

enum SessionMode {
  NoSession,
  Private,
  AuthenticatedPublic,
}

interface ContextualCacheKey {
  sessionMode: SessionMode;
  sessionId?: string | null;
}

interface CacheValue {
  // Note: we only store data responses in the cache, not errors.
  //
  // There are two reasons we don't cache errors. The user-level reason is that
  // we think that in general errors are less cacheable than real results, since
  // they might indicate something transient like a failure to talk to a
  // backend. (If you need errors to be cacheable, represent the erroneous
  // condition explicitly in data instead of out-of-band as an error.) The
  // implementation reason is that this lets us avoid complexities around
  // serialization and deserialization of GraphQL errors, and the distinction
  // between formatted and unformatted errors, etc.
  data: Record<string, any>;
  cachePolicy: Required<CacheHint>;
  cacheTime: number; // epoch millis, used to calculate Age header
}

type CacheKey = Record<string, any> & ContextualCacheKey;

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function cacheKeyAsString(key: CacheKey) {
  return sha256(JSON.stringify(key));
}

function isGraphQLQuery(requestContext: GraphQLRequestContext<any>) {
  return (
    requestContext.operation && requestContext.operation.operation === "query"
  );
}

export default function plugin(
  options: CacheOptions = Object.create(null)
): ApolloServerPlugin {
  return {
    requestDidStart(
      outerRequestContext: GraphQLRequestContext<any>
    ): GraphQLRequestListener<any> {
      const cache = new PrefixingKeyValueCache(
        options.cache || outerRequestContext.cache!,
        "fqc:"
      );

      let sessionId: string | null = null;
      let cacheKey: CacheKey | null = null;
      let age: number | null = null;

      return {
        async responseForOperation(
          requestContext
        ): Promise<GraphQLResponse | null> {
          requestContext.metrics.responseCacheHit = false;

          if (!isGraphQLQuery(requestContext)) {
            return null;
          }

          async function cacheGet(
            contextualCacheKeyFields: ContextualCacheKey
          ): Promise<GraphQLResponse | null> {
            const key = cacheKeyAsString({
              ...cacheKey!,
              ...contextualCacheKeyFields,
            });
            const serializedValue = await cache.get(key);
            if (serializedValue === undefined) {
              return null;
            }

            const value: CacheValue = JSON.parse(serializedValue);
            // Use cache policy from the cache (eg, to calculate HTTP response
            // headers).
            requestContext.overallCachePolicy = value.cachePolicy;
            requestContext.metrics.responseCacheHit = true;
            age = Math.round((+new Date() - value.cacheTime) / 1000);
            return { data: value.data };
          }

          // Call hooks. Save values which will be used in willSendResponse as well.
          let extraCacheKeyData: any = null;
          if (options.sessionId) {
            sessionId = await options.sessionId(requestContext);
          }

          cacheKey = await options.cacheKey(requestContext);

          // Note that we set up sessionId and baseCacheKey before doing this
          // check, so that we can still write the result to the cache even if
          // we are told not to read from the cache.
          if (
            options.shouldReadFromCache &&
            !options.shouldReadFromCache(requestContext)
          ) {
            return null;
          }

          if (sessionId === null) {
            return cacheGet({ sessionMode: SessionMode.NoSession });
          } else {
            const privateResponse = await cacheGet({
              sessionId,
              sessionMode: SessionMode.Private,
            });
            if (privateResponse !== null) {
              return privateResponse;
            }
            return cacheGet({ sessionMode: SessionMode.AuthenticatedPublic });
          }
        },

        async willSendResponse(requestContext) {
          const logger = requestContext.logger || console;

          if (!isGraphQLQuery(requestContext)) {
            return;
          }
          if (requestContext.metrics.responseCacheHit) {
            // Never write back to the cache what we just read from it. But do set the Age header!
            const http = requestContext.response.http;
            if (http && age !== null) {
              http.headers.set("age", age.toString());
            }
            return;
          }
          if (
            options.shouldWriteToCache &&
            !options.shouldWriteToCache(requestContext)
          ) {
            return;
          }

          const { response, overallCachePolicy } = requestContext;
          if (
            response.errors ||
            !response.data ||
            !overallCachePolicy ||
            overallCachePolicy.maxAge <= 0
          ) {
            // This plugin never caches errors or anything without a cache policy.
            //
            // There are two reasons we don't cache errors. The user-level
            // reason is that we think that in general errors are less cacheable
            // than real results, since they might indicate something transient
            // like a failure to talk to a backend. (If you need errors to be
            // cacheable, represent the erroneous condition explicitly in data
            // instead of out-of-band as an error.) The implementation reason is
            // that this lets us avoid complexities around serialization and
            // deserialization of GraphQL errors, and the distinction between
            // formatted and unformatted errors, etc.
            return;
          }

          const data = response.data!;

          // We're pretty sure that any path that calls willSendResponse with a
          // non-error response will have already called our execute hook above,
          // but let's just double-check that, since accidentally ignoring
          // sessionId could be a big security hole.
          if (!cacheKey) {
            throw new Error(
              "willSendResponse called without error, but execute not called?"
            );
          }

          function cacheSetInBackground(
            contextualCacheKeyFields: ContextualCacheKey
          ) {
            const key = cacheKeyAsString({
              ...cacheKey!,
              ...contextualCacheKeyFields,
            });
            const value: CacheValue = {
              data,
              cachePolicy: overallCachePolicy!,
              cacheTime: +new Date(),
            };
            const serializedValue = JSON.stringify(value);
            // Note that this function converts key and response to strings before
            // doing anything asynchronous, so it can run in parallel with user code
            // without worrying about anything being mutated out from under it.
            //
            // Also note that the test suite assumes that this asynchronous function
            // still calls `cache.set` synchronously (ie, that it writes to
            // InMemoryLRUCache synchronously).
            cache
              .set(key, serializedValue, { ttl: overallCachePolicy!.maxAge })
              .catch(logger.warn);
          }

          const isPrivate = overallCachePolicy.scope === CacheScope.Private;
          if (isPrivate) {
            if (!options.sessionId) {
              logger.warn(
                "A GraphQL response used @cacheControl or setCacheHint to set cache hints with scope " +
                  "Private, but you didn't define the sessionId hook for " +
                  "apollo-server-plugin-response-cache. Not caching."
              );
              return;
            }
            if (sessionId === null) {
              // Private data shouldn't be cached for logged-out users.
              return;
            }
            cacheSetInBackground({
              sessionId,
              sessionMode: SessionMode.Private,
            });
          } else {
            cacheSetInBackground({
              sessionMode:
                sessionId === null
                  ? SessionMode.NoSession
                  : SessionMode.AuthenticatedPublic,
            });
          }
        },
      };
    },
  };
}
