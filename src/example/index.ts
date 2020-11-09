import express from "express";
import { ApolloServer, gql } from "apollo-server-express";
import { QueryResponseCachePlugin } from "../lib";
import { RedisCache } from "apollo-server-cache-redis";
import morgan from "morgan";

const queryResponseCachePlugin = QueryResponseCachePlugin({
  // the cache key data should provide at the very least the operationName
  cacheKeyData: (context) => ({
    operationName: context.operationName!,
    variables: { ...(context.request.variables || {}) },
  }),
  cache: new RedisCache({
    host: "localhost",
    port: 6379,
  }),
});

const app = express();

app.use(morgan("combined"));

const schema = gql`
  type Query {
    me: User
  }

  type User {
    username: String!
  }
`;

const resolvers = {
  Query: {
    me: () => {
      return {
        username: "Robin Wieruch",
      };
    },
  },
};

const server = new ApolloServer({
  typeDefs: schema,
  resolvers,
  plugins: [queryResponseCachePlugin],
  tracing: true,
  cacheControl: {
    defaultMaxAge: 15,
  },
});

server.applyMiddleware({ app, path: "/graphql" });

app.listen({ port: 8000 }, () => {
  console.log("🚀 Apollo Server on http://localhost:8000/graphql");
});
