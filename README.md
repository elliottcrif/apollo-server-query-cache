# Apollo Server Query Cache

Full Query Response cache plugin for [Apollo Server](https://github.com/apollographql/apollo-server)

Heavily based off of [Apollo Server Plugin Response Cache](https://github.com/apollographql/apollo-server/tree/main/packages/apollo-server-plugin-response-cache)

## Enhancements

- [x] Custom Cache Key Data
  - Request could only be cached from the same source in the previous implementation. Fine grained control of the cache key data allows for developers to set the cache key data as their application sees fit. This allows queries to be cached on the server across multiple request origins.
