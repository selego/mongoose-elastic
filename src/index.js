function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function MongooseElastic(esClient, options = {}) {
  return (schema, index) =>
    MongooseElasticPlugin(schema, index, esClient, options);
}

function MongooseElasticPlugin(schema, index, esClient, options) {
  const mapping = getMapping(schema, options);
  const indexName = index;
  const typeName = "_doc";

  if (!esClient) return;

  //ElasticSearch Client
  async function createMapping() {
    try {
      const exists = await esClient.indices.exists({ index: indexName });
      if (!exists) await esClient.indices.create({ index: indexName });
    } catch (e) {
      console.log("Error update mapping", e.meta.body);
    }
  }

  createMapping();

  //use this function if you want to update elastic search mapping
  schema.statics.updateMapping = function schemaIndex() {
    return new Promise(async (resolve, reject) => {
      try {
        const exists = await esClient.indices.exists({ index: indexName });
        if (exists) await esClient.indices.delete({ index: indexName });
        await esClient.indices.create({ index: indexName });
        const completeMapping = {};
        completeMapping[typeName] = getMapping(schema);
        await esClient.indices.putMapping({
          index: indexName,
          type: typeName,
          include_type_name: true,
          body: completeMapping,
        });
        console.log("Mapping created");
        resolve();
      } catch (e) {
        console.log("Error update mapping", e);
        reject();
      }
    });
  };

  schema.statics.logMapping = function schemaIndex() {
    return new Promise(async (resolve, reject) => {
      const map = await esClient.indices.getMapping({ index: indexName });
      console.log("map", JSON.stringify(map.body.mission, null, 2));
    });
  };

  schema.methods.index = function schemaIndex() {
    return new Promise(async (resolve, reject) => {
      try {
        const _opts = { index: indexName, type: typeName, refresh: true };
        _opts.body = serialize(this, mapping);
        _opts.id = this._id.toString();
        await esClient.index(_opts);
      } catch (e) {
        console.log(`Error index ${this._id.toString()}`, e.message || e);
        return reject();
      }
      resolve();
    });
  };

  schema.methods.unIndex = function schemaUnIndex() {
    return new Promise(async (resolve, reject) => {
      try {
        const _opts = { index: indexName, type: typeName, refresh: true };
        _opts.id = this._id.toString();

        let tries = 3;
        while (tries > 0) {
          try {
            await esClient.delete(_opts);
            return resolve();
          } catch (e) {
            console.log(e);
            await timeout(500);
            --tries;
          }
        }
      } catch (e) {
        console.log(`Error delete ${this._id.toString()}`, e.message || e);
        return reject();
      }
      resolve();
    });
  };

  schema.statics.synchronize = async function synchronize() {
    let count = 0;
    try {
      await this.find({})
        .cursor()
        .eachAsync(async (u) => {
          await u.index();
          count++;
          if (count % 100 == 0) console.log(`${count} indexed`);
        });
    } catch (e) {
      console.log(e);
    }
  };

  schema.statics.unsynchronize = function unsynchronize() {
    return new Promise(async (resolve, reject) => {
      try {
        const exists = await esClient.indices.exists({ index: indexName });
        if (exists) await esClient.indices.delete({ index: this.modelName });
      } catch (e) {
        console.log("e", e);
      }
      resolve();
    });
  };

  function postRemove(doc) {
    if (!doc) return;
    const _doc = new doc.constructor(doc);
    return _doc.unIndex();
  }

  async function postSave(doc) {
    if (!doc) return;
    if (options && options.selectiveIndexing) {
      const ignoredProperties = options.ignore || [];
      for (let key of doc.$locals._modifiedPaths) {
        if (!ignoredProperties.includes(key)) {
          // a non-ignored path was modified: the document is indexed
          const _doc = new doc.constructor(doc);
          if (Array.isArray(options.populate)) await _doc.populate(options.populate).execPopulate();
          return _doc.index();
        }
      }
    } else {
      const _doc = new doc.constructor(doc);
      if (Array.isArray(options.populate)) await _doc.populate(options.populate).execPopulate();
      return _doc.index();
    }
  }

  /**
   * Use standard Mongoose Middleware hooks
   * to persist to Elasticsearch
   */
  function setUpMiddlewareHooks(inSchema) {
    inSchema.post("remove", postRemove);
    inSchema.post("findOneAndRemove", postRemove);
    inSchema.post("save", postSave);
    inSchema.post("findOneAndUpdate", postSave);
    schema.pre('save', function(next) {
      this.$locals._modifiedPaths = this.modifiedPaths();
      next();
    });
    inSchema.pre("deleteMany", (docs) => {
      return new Promise(async (resolve, reject) => {
        for (let i = 0; i < docs.length; i++) {
          try {
            await postRemove(docs[i]);
          } catch (e) {}
        }
        resolve();
      });
    });

    //deleteMany

    inSchema.post("insertMany", (docs) => {
      return new Promise(async (resolve, reject) => {
        for (let i = 0; i < docs.length; i++) {
          try {
            await postSave(docs[i]);
          } catch (e) {}
        }
        resolve();
      });
    });
  }

  setUpMiddlewareHooks(schema);
}

function getMapping(schema, options) {
  const properties = {};

  for (let i = 0; i < Object.keys(schema.paths).length; i++) {
    const key = Object.keys(schema.paths)[i];

    const exclude = ["id", "__v", "_id"];
    if (exclude.includes(key)) continue;
    if (options && options.ignore && options.ignore.includes(key)) continue;

    const mongooseType = schema.paths[key].instance;

    if (schema.paths[key].options.es_mapping) {
      properties[key] = schema.paths[key].options.es_mapping;
      continue;
    }

    //geoloc

    if (key === "location.lat") continue;
    if (key === "location.lon") {
      properties["location"] = { type: "geo_point" };
      continue;
    }

    const esType = mongooseTypeToEsType(mongooseType, { schema, key });
    if (esType) properties[key] = esType;
  }

  if (options && Array.isArray(options.virtuals)) {
    for (const virtual of options.virtuals) {
      const esType = mongooseTypeToEsType(virtual.type, {});
      if (esType) properties[virtual.key] = esType;
    }
  }

  return { properties };
}

function mongooseTypeToEsType(mongooseType, { schema, key }) {
  switch (mongooseType) {
    case "ObjectID":
    case "String":
      return {
        type: "text",
        fields: { keyword: { type: "keyword", ignore_above: 256 } },
      };
    case "Date":
      return { type: "date" };
    case "Number":
      return { type: "long" };
    case "Boolean":
      return { type: "boolean" };

    case "Array":
      if (!schema || !key) {
        console.warn("Array not yet supported for virtuals");
        break;
      }

      if (schema.paths[key].caster.instance === "String") {
        return {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        };
      }
      const newschema = schema.paths[key].schema;
      if (!newschema) break;
      return {
        type: "nested",
        properties: getMapping(newschema).properties,
      };
    default:
      console.log("default", mongooseType);
      break;
  }
}

function serialize(model, mapping) {
  let name, outModel;

  function _serializeObject(object, mappingData) {
    let serialized = {};
    let field;
    let val;
    for (field in mappingData.properties) {
      if (mappingData.properties.hasOwnProperty(field)) {
        val = serialize.call(
          object,
          object[field],
          mappingData.properties[field]
        );
        if (val === undefined) continue;
        if (
          mappingData.properties[field].type === "geo_point" &&
          val &&
          (val.lat === undefined || val.lon === undefined)
        )
          continue;

        serialized[field] = val;
      }
    }
    return serialized;
  }

  if (mapping.properties && model) {
    if (Array.isArray(model))
      return model.map((object) => _serializeObject(object, mapping));
    return _serializeObject(model, mapping);
  }

  if (mapping.cast && typeof mapping.cast !== "function")
    throw new Error("es_cast must be a function");

  outModel = mapping.cast ? mapping.cast.call(this, model) : model;
  if (typeof outModel === "object" && outModel !== null) {
    name = outModel.constructor.name;
    if (name === "ObjectID") return outModel.toString();
    if (name === "Date") return new Date(outModel).toJSON();
  }

  return outModel;
}

module.exports = MongooseElastic;
