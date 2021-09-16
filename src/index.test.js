const { Client } = require("@elastic/elasticsearch");
const mongoose = require("mongoose");
const mongooseElastic = require("./index.js");

test("readme example should work", async () => {
  const client = new Client({ node: "http://localhost:9200" });

  const User = new mongoose.Schema({
    name: String,
    email: String,
    city: String,
    shouldBeIgnored: String,
  });
  await User.plugin(
    mongooseElastic(client, { ignore: ["shouldBeIgnored"] }),
    "user"
  );
  const UserModel = await mongoose.model("user", User);
  expect(3).toBe(3);

  mongoose.connect("mongodb://localhost:27017/test", {
    useCreateIndex: true,
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  const user = new UserModel({
    name: "Raph 2",
    email: "raph@example.org",
    city: "Nantes",
    shouldBeIgnored: "hop",
  });
  await user.save();
  expect(3).toBe(3);
});
