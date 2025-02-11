import { SQLiteClient } from "../../deps.ts";
import type { Connector, ConnectorOptions } from "./connector.ts";
import type { QueryDescription } from "../query-builder.ts";
import type { FieldValue } from "../data-types.ts";
import { SQLTranslator } from "../translators/sql-translator.ts";
import type { SupportedSQLDatabaseDialect } from "../translators/sql-translator.ts";

export interface SQLite3Options extends ConnectorOptions {
  filepath: string;
}

export class SQLite3Connector implements Connector {
  _dialect: SupportedSQLDatabaseDialect = "sqlite3";

  _client: SQLiteClient;
  _options: SQLite3Options;
  _translator: SQLTranslator;
  _connected = false;

  /** Create a SQLite connection. */
  constructor(options: SQLite3Options) {
    this._options = options;
    this._client = new SQLiteClient(this._options.filepath);
    this._translator = new SQLTranslator(this._dialect);
  }

  _makeConnection() {
    if (this._connected) {
      return;
    }

    this._connected = true;
  }

  ping() {
    this._makeConnection();

    try {
      let connected = false;

      for (const [result] of this._client.query("SELECT 1 + 1")) {
        connected = result === 2;
      }

      return Promise.resolve(connected);
    } catch {
      return Promise.resolve(false);
    }
  }

  query(queryDescription: QueryDescription): Promise<any | any[]> {
    this._makeConnection();

    const query = this._translator.translateToQuery(queryDescription);
    const subqueries = query.split(";");

    const results = subqueries.map(async (subquery, index) => {
      const response = this._client.query(subquery + ";", []);

      if (index < subqueries.length - 1) {
        response.return();
        return [];
      }

      const results = [];
      let columns;

      try {
        columns = response.columns();
      } catch {
        // If there are no matching records, .columns will throw an error
        if (queryDescription.type === "insert" && queryDescription.values) {
          return {
            affectedRows: this._client.changes,
            lastInsertId: this._client.lastInsertRowId,
          };
        }

        return { affectedRows: this._client.changes };
      }

      for (const row of response) {
        const result: { [k: string]: FieldValue } = {};

        let i = 0;
        for (const column of row!) {
          const columnName = columns[i].name;
          if (columnName === "count(*)") {
            result.count = column;
          } else if (columnName.startsWith("max(")) {
            result.max = column;
          } else if (columnName.startsWith("min(")) {
            result.min = column;
          } else if (columnName.startsWith("sum(")) {
            result.sum = column;
          } else if (columnName.startsWith("avg(")) {
            result.avg = column;
          } else {
            result[columns[i].name] = column;
          }

          i++;
        }

        results.push(result);
      }

      return results;
    });

    return results[results.length - 1];
  }

  async transaction(queries: () => Promise<void>) {
    this._client.query("begin");

    try {
      await queries();
      this._client.query("commit");
    } catch (error) {
      this._client.query("rollback");
      throw error;
    }
  }

  close() {
    if (!this._connected) {
      return Promise.resolve();
    }

    this._client.close();
    this._connected = false;
    return Promise.resolve();
  }
}
