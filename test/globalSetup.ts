import { MongoMemoryServer } from 'mongodb-memory-server';

// One MongoDB for the whole run. Its address reaches the test processes through
// the environment, which the forked workers inherit.
let mongo: MongoMemoryServer | undefined;

export async function setup(): Promise<void> {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
}

export async function teardown(): Promise<void> {
  await mongo?.stop();
}
