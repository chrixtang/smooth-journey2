// Tiny data layer over one DynamoDB table (pk, sk, optional gsi1pk/gsi1sk, optional ttl).
// Swappable with an in-memory version for tests.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

function dynamo(table) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    async get(pk, sk) { return (await doc.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item || null; },
    async put(item) { await doc.send(new PutCommand({ TableName: table, Item: item })); },
    async putIfAbsent(item) {
      try { await doc.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: "attribute_not_exists(pk)" })); return true; }
      catch (e) { if (e && e.name === "ConditionalCheckFailedException") return false; throw e; }
    },
    async del(pk, sk) { await doc.send(new DeleteCommand({ TableName: table, Key: { pk, sk } })); },
    async query(pk, prefix) {
      const out = []; let start;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: table, ExclusiveStartKey: start,
          KeyConditionExpression: prefix ? "pk = :p AND begins_with(sk, :s)" : "pk = :p",
          ExpressionAttributeValues: prefix ? { ":p": pk, ":s": prefix } : { ":p": pk }
        }));
        out.push(...(r.Items || [])); start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async byIndex(gsi1pk) {
      const out = []; let start;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: table, IndexName: "gsi1", ExclusiveStartKey: start,
          KeyConditionExpression: "gsi1pk = :g", ExpressionAttributeValues: { ":g": gsi1pk }
        }));
        out.push(...(r.Items || [])); start = r.LastEvaluatedKey;
      } while (start);
      return out;
    }
  };
}

export function memoryDb() {
  const m = new Map();
  const k = (pk, sk) => pk + "\u0000" + sk;
  const copy = (x) => (x ? JSON.parse(JSON.stringify(x)) : null);
  return {
    _map: m,
    async get(pk, sk) { return copy(m.get(k(pk, sk))); },
    async put(item) { m.set(k(item.pk, item.sk), copy(item)); },
    async putIfAbsent(item) { if (m.has(k(item.pk, item.sk))) return false; m.set(k(item.pk, item.sk), copy(item)); return true; },
    async del(pk, sk) { m.delete(k(pk, sk)); },
    async query(pk, prefix) { return [...m.values()].filter((i) => i.pk === pk && (!prefix || i.sk.startsWith(prefix))).sort((a, b) => (a.sk < b.sk ? -1 : 1)).map(copy); },
    async byIndex(g) { return [...m.values()].filter((i) => i.gsi1pk === g).sort((a, b) => ((a.gsi1sk || "") < (b.gsi1sk || "") ? -1 : 1)).map(copy); }
  };
}

let current = null;
export function db() { if (!current) current = dynamo(process.env.TABLE_NAME); return current; }
export function _setDb(d) { current = d; }   // tests only
