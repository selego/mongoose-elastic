import { Client } from "@elastic/elasticsearch";
import { Document, Model, Schema } from "mongoose";

// Temporary fix, should be fixed here: https://github.com/Automattic/mongoose/pull/10865
declare module "mongoose" {
  interface SchemaType {
    caster?: SchemaType;
    instance?: string;
    options?: {
      es_mapping: any;
    };
    schema?: any;
  }
}

interface IndexableDocument extends Document {
  index(): Promise<boolean>;
}

interface Mapping {
  cast?: () => any;
  properties: {
    [key: string]: {
      type?: string;
      es_mapping?: any;
      properties?: Mapping;
    };
  };
}

interface PluginOptions {
  ignore?: string[];
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function MongooseElasticPlugin(
  schema: Schema,
  index: string,
  esClient: Client,
  options: PluginOptions
) {
  const mapping: Mapping = getMapping(schema, options);
  const indexName = index;
  const typeName = "_doc";

  if (!esClient) return;

  async function createMapping() {
    try {
      const exists = await esClient.indices.exists({ index: indexName });
      if (!exists) await esClient.indices.create({ index: indexName });
    } catch (e) {
      console.log("Error update mapping", e.meta.body);
    }
  }

  createMapping();

  // Use this function if you want to update elastic search mapping.
  schema.statics.updateMapping = function schemaIndex() {
    return new Promise(async (resolve, reject) => {
      try {
        const exists = await esClient.indices.exists({ index: indexName });
        if (exists) await esClient.indices.delete({ index: indexName });
        await esClient.indices.create({ index: indexName });
        const completeMapping = {};
        completeMapping[typeName] = getMapping(schema, options);
        await esClient.indices.putMapping({
          index: indexName,
          type: typeName,
          include_type_name: true,
          body: completeMapping,
        });
        console.log("Mapping created");
        resolve(true);
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
        await esClient.index({
          index: indexName,
          type: typeName,
          refresh: true,
          body: serialize(this, mapping),
          id: this._id.toString(),
        });
      } catch (e) {
        console.log(`Error index ${this._id.toString()}`, e.message || e);
        return reject();
      }
      resolve(true);
    });
  };

  schema.methods.unIndex = function schemaUnIndex() {
    return new Promise(async (resolve, reject) => {
      try {
        let tries = 3;
        while (tries > 0) {
          try {
            await esClient.delete({
              index: indexName,
              type: typeName,
              refresh: true,
              id: this._id.toString(),
            });
            return resolve(true);
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
      resolve(true);
    });
  };

  schema.statics.synchronize = async function synchronize() {
    let count = 0;
    try {
      await this.find({})
        .cursor()
        .eachAsync(async (u: IndexableDocument) => {
          await u.index();
          count++;
          if (count % 100 == 0) console.log(`${count} indexed`);
        });
    } catch (e) {
      console.log(e);
    }
  };

  schema.statics.synchronizeBulk = async function synchronize(
    bulkSize: number = 10_000
  ) {
    try {
      let success = 0;
      console.log("ℹ️ Indexing started");
      while (true) {
        const documents = await this.find().limit(bulkSize).skip(success);

        if (documents.length === 0) break;

        const bodyES = documents.flatMap((document) => {
          let documentFormatted = serialize(document, mapping);
          return [
            { index: { _index: indexName, _id: document._id.toString() } },
            documentFormatted,
          ];
        });
        const { body: esResponse } = await esClient.bulk({
          refresh: true,
          body: bodyES,
        });

        // ? Error ES BULK
        if (esResponse.errors) {
          const erroredDocuments = [];
          esResponse.items.forEach((action, i) => {
            const operation = Object.keys(action)[0];
            if (action[operation].error) {
              erroredDocuments.push({
                status: action[operation].status,
                error: action[operation].error,
                operation: bodyES[i * 2],
                document: bodyES[i * 2 + 1],
              });
            }
          });
          console.log(`❌ ERROR: ${erroredDocuments}`);
        }

        success += documents.length;
        console.log(`✅  ${success} documents indexed`);
      }
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
      resolve(true);
    });
  };

  function postRemove(doc) {
    if (!doc) return;
    const _doc = new doc.constructor(doc);
    return _doc.unIndex();
  }

  function postSave(doc) {
    if (!doc) return;
    const _doc = new doc.constructor(doc);
    return _doc.index();
  }

  function setUpMiddlewareHooks(inSchema) {
    inSchema.post("remove", postRemove);
    inSchema.post("findOneAndRemove", postRemove);
    inSchema.post("save", postSave);
    inSchema.post("findOneAndUpdate", postSave);
    inSchema.pre("deleteMany", (docs) => {
      return new Promise(async (resolve, reject) => {
        for (let i = 0; i < docs.length; i++) {
          try {
            await postRemove(docs[i]);
          } catch (e) {}
        }
        resolve(true);
      });
    });

    inSchema.post("insertMany", (docs) => {
      return new Promise(async (resolve, reject) => {
        for (let i = 0; i < docs.length; i++) {
          try {
            await postSave(docs[i]);
          } catch (e) {}
        }
        resolve(true);
      });
    });
  }

  setUpMiddlewareHooks(schema);
}

function getMapping(schema: Schema, options: PluginOptions): Mapping {
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

    // Geoloc (legacy for internal use)
    if (key === "location.lat") continue;
    if (key === "location.lon") {
      properties["location"] = { type: "geo_point" };
      continue;
    }

    switch (mongooseType) {
      case "ObjectID":
      case "String":
        properties[key] = {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        };
        break;
      case "Date":
        properties[key] = { type: "date" };
        break;
      case "Number":
        properties[key] = { type: "long" };
        break;
      case "Boolean":
        properties[key] = { type: "boolean" };
        break;

      case "Array":
        if (schema.paths[key].caster.instance === "String") {
          properties[key] = {
            type: "text",
            fields: { keyword: { type: "keyword", ignore_above: 256 } },
          };
        }
        const newschema = schema.paths[key].schema;
        if (!newschema) break;
        properties[key] = {
          type: "nested",
          properties: getMapping(newschema, options).properties,
        };

        break;
      default:
        console.log("default", mongooseType);
        break;
    }
  }

  return { properties } as Mapping;
}

function serialize(model: Document<any>, mapping: Mapping) {
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

export default function MongooseElastic(
  esClient: Client,
  options: PluginOptions = {}
) {
  return (schema: Schema, index: string) =>
    MongooseElasticPlugin(schema, index, esClient, options);
}
