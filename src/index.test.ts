import mongoose from "mongoose";
import MongooseElastic from "./index";
import { Client } from "@elastic/elasticsearch";

const mongooseUrl = "mongodb://localhost:27017/test";
const elasticUrl = "http://localhost:9200";

async function createTestContext(schema, mongooseElasticOptions = {}) {
  const modelName = Math.random().toString(36).substring(2);
  const client = new Client({ node: elasticUrl });
  await mongoose.connect(mongooseUrl);
  const Schema = new mongoose.Schema(schema);
  await Schema.plugin(
    MongooseElastic(client, mongooseElasticOptions),
    modelName
  );
  const Model = await mongoose.model(modelName, Schema);
  try {
    await Model.collection.drop();
  } catch (e) {}

  return {
    client,
    Model,
    modelName,
  };
}

async function cleanUp(client, Model, modelName) {
  await client.indices.delete({ index: modelName });
  await Model.collection.drop();
}

afterEach(async () => {
  await mongoose.disconnect();
});

it("should create model in both mongoDB and Elasticsearch", async () => {
  const { client, Model, modelName } = await createTestContext({
    name: String,
  });

  const user = new Model({ name: "test" });
  await user.save();

  const userFromDb = await Model.findOne({ name: "test" });
  expect(userFromDb).toBeTruthy();

  const { body } = await client.get({ index: modelName, id: user.id });
  expect(body._source.name).toBe("test");

  await cleanUp(client, Model, modelName);
});

it("should exclude ignored fields", async () => {
  const { client, Model, modelName } = await createTestContext(
    { name: String, shouldBeIgnored: String },
    { ignore: ["shouldBeIgnored"] }
  );

  const user = new Model({ name: "test", shouldBeIgnored: "test2" });
  await user.save();

  const { body } = await client.get({ index: modelName, id: user.id });
  expect(body._source.name).toBe("test");
  expect(body._source.shouldBeIgnored).toBeUndefined();
  await cleanUp(client, Model, modelName);
});

it("should work with arrays", async () => {
  const { client, Model, modelName } = await createTestContext({
    name: String,
    emails: [String],
  });

  const user = new Model({ name: "foo", emails: ["test2", "test3"] });
  await user.save();
  const user2 = new Model({ name: "bar", emails: ["test4"] });
  await user2.save();

  const res = await client.get({ index: modelName, id: user.id });
  expect(res.body._source.name).toBe("foo");
  expect(res.body._source.emails).toStrictEqual(["test2", "test3"]);

  const res2 = await client.get({ index: modelName, id: user2.id });
  expect(res2.body._source.name).toBe("bar");
  expect(res2.body._source.emails).toStrictEqual(["test4"]);
  await cleanUp(client, Model, modelName);
});

it("should synchronize bulk", async () => {
  const { client, Model, modelName } = await createTestContext({
    name: String,
    emails: [String],
  });

  // Create 10 users
  for (let i = 0; i < 10; i++) {
    const user = new Model({ name: "foo" + i, emails: ["test2", "test3"] });
    await user.save();
  }
  // Empty index
  await client.indices.delete({ index: modelName });
  await client.indices.create({ index: modelName });

  const r = await client.search({ index: modelName });
  expect(r.body.hits.total.value).toBe(0);

  // Bulk sync
  await (Model as any).synchronizeBulk();

  // Check if all users are in the index
  const res = await client.search({ index: modelName });
  expect(res.body.hits.total.value).toBe(10);
  await cleanUp(client, Model, modelName);
});
