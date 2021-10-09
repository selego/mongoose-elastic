# Mongoose Elastic

Mongoose Elastic is a [mongoose](http://mongoosejs.com/) plugin that can automatically index your models into [elasticsearch](https://www.elastic.co/).

[![Version](https://img.shields.io/npm/v/@selego/mongoose-elastic.svg)](https://www.npmjs.com/package/@selego/mongoose-elastic)
[![Downloads/week](https://img.shields.io/npm/dt/@selego/mongoose-elastic.svg)](https://www.npmjs.com/package/@selego/mongoose-elastic)
[![License](https://img.shields.io/npm/l/@selego/mongoose-elastic.svg)](https://github.com/selego/mongoose-elastic/blob/master/package.json)

## Usage

Install the package.

```bash
npm i @selego/mongoose-elastic
```

Setup your mongoose model to use the plugin.

```javascript
const { Client } = require("@elastic/elasticsearch");
const mongoose = require("mongoose");
const mongooseElastic = require("@selego/mongoose-elastic");

const client = new Client({ node: "http://localhost:9200" });

const User = new mongoose.Schema({
  name: String,
  email: String,
  city: String,
});

User.plugin(mongooseElastic(client), "user");

module.exports = mongoose.model("user", User);
```

Then, use your mongoose model as usual:

```js
const user = new User({ name: "Raph" });
user.save().then(() => {
  console.log("user saved on mongo, elastic sync is on its way");
});
```

## Why

There are some competitors, still, most of them are abandonned or suffering from their legacy.

- [mongoosastic](https://github.com/mongoosastic/mongoosastic) is [looking for maintainers](https://github.com/mongoosastic/mongoosastic/issues/457) since 2018 and has to deal with legacy.
- [mongoose-elasticsearch](https://www.npmjs.com/package/mongoose-elasticsearch) has been abandonned in 2014.
- [mongoose-elastic](https://www.npmjs.com/package/mongoose-elastic) has been discontinued in 2014 and repo is deleted.
