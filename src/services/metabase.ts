type CellValue = string | number;

type MetabaseColumn = {
  name?: string;
  display_name?: string;
};

type MetabaseDatasetResponse = {
  status?: string;
  error?: string;
  error_type?: string;
  data?: {
    cols?: MetabaseColumn[];
    rows?: unknown[][];
  };
};

type MetabaseDatabase = {
  id: number;
  name: string;
};

type MetabaseTable = {
  id: number;
  name: string;
};

type MetabaseField = {
  id: number;
  name: string;
};

type MetabaseDatabaseListResponse = {
  data?: MetabaseDatabase[];
};

type MetabaseDatabaseMetadataResponse = {
  tables?: MetabaseTable[];
};

type MetabaseTableMetadataResponse = {
  fields?: MetabaseField[];
};

export type TabularDataset = {
  columns: string[];
  rows: CellValue[][];
};

export type MetabaseConfig = {
  url: string;
  email: string;
  password: string;
  databaseId: number;
};

const DEFAULT_LIMIT = 2000;

function cleanCell(value: unknown): CellValue {
  const cleaned = String(value ?? "")
    .replace(/[\n\r\t]/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (cleaned !== "" && /^-?\d+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned);
  }

  return cleaned;
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function metabaseJson<T>(
  config: MetabaseConfig,
  sessionToken: string,
  path: string,
  init?: RequestInit
) {
  const response = await fetch(joinUrl(config.url, path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": sessionToken,
      ...init?.headers
    }
  });

  const body = await response.json() as T;

  if (!response.ok) {
    throw new Error(`Metabase request failed: ${response.status}`);
  }

  return body;
}

async function authenticate(config: MetabaseConfig) {
  const response = await fetch(joinUrl(config.url, "/api/session"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: config.email,
      password: config.password
    })
  });

  if (!response.ok) {
    throw new Error(`Metabase authentication failed: ${response.status}`);
  }

  const body = await response.json() as { id?: string };

  if (!body.id) {
    throw new Error("Metabase authentication response did not include a session id.");
  }

  return body.id;
}

async function executeNativeQuery(
  config: MetabaseConfig,
  sessionToken: string,
  query: string
) {
  const result = await metabaseJson<MetabaseDatasetResponse>(config, sessionToken, "/api/dataset", {
    method: "POST",
    body: JSON.stringify({
      database: config.databaseId,
      type: "native",
      native: { query },
      display: "table"
    })
  });

  if (result.status === "failed") {
    throw new Error(`Metabase native query failed: ${result.error_type ?? result.error ?? "unknown error"}`);
  }

  return result;
}

async function executeStructuredQuery(
  config: MetabaseConfig,
  sessionToken: string,
  body: unknown
) {
  const result = await metabaseJson<MetabaseDatasetResponse>(config, sessionToken, "/api/dataset", {
    method: "POST",
    body: JSON.stringify(body)
  });

  if (result.status === "failed") {
    throw new Error(`Metabase structured query failed: ${result.error_type ?? result.error ?? "unknown error"}`);
  }

  return result;
}

async function listDatabases(config: MetabaseConfig, sessionToken: string) {
  const result = await metabaseJson<MetabaseDatabaseListResponse>(config, sessionToken, "/api/database");
  return result.data ?? [];
}

async function listTables(config: MetabaseConfig, sessionToken: string, databaseId: number) {
  const result = await metabaseJson<MetabaseDatabaseMetadataResponse>(
    config,
    sessionToken,
    `/api/database/${databaseId}/metadata`
  );
  return result.tables ?? [];
}

async function listFields(config: MetabaseConfig, sessionToken: string, tableId: number) {
  const result = await metabaseJson<MetabaseTableMetadataResponse>(
    config,
    sessionToken,
    `/api/table/${tableId}/query_metadata`
  );
  return result.fields ?? [];
}

async function findUsersSource(config: MetabaseConfig, sessionToken: string) {
  const databases = await listDatabases(config, sessionToken);
  const orderedDatabases = [
    ...databases.filter((database) => database.id === config.databaseId),
    ...databases.filter((database) => database.id !== config.databaseId)
  ];

  for (const database of orderedDatabases) {
    const tables = await listTables(config, sessionToken, database.id);
    const usersTable = tables.find((table) => table.name === "users");

    if (!usersTable) {
      continue;
    }

    const fields = await listFields(config, sessionToken, usersTable.id);
    const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
    const username = fieldByName.get("username");
    const name = fieldByName.get("name");
    const birthdate = fieldByName.get("birthdate");
    const isAdmin = fieldByName.get("is_admin");

    if (username && name && birthdate && isAdmin) {
      return {
        databaseId: database.id,
        tableId: usersTable.id,
        fields: { username, name, birthdate, isAdmin }
      };
    }
  }

  throw new Error("Tidak menemukan tabel users dengan field username, name, birthdate, dan is_admin.");
}

export async function fetchNativeQueryWithPagination(
  config: MetabaseConfig,
  baseQuery: string,
  limit = DEFAULT_LIMIT
): Promise<TabularDataset> {
  const sessionToken = await authenticate(config);
  const rows: CellValue[][] = [];
  let columns: string[] = [];
  let offset = 0;

  while (true) {
    const query = `${baseQuery} LIMIT ${limit} OFFSET ${offset}`;
    const result = await executeNativeQuery(config, sessionToken, query);
    const rawRows = result.data?.rows ?? [];

    if (columns.length === 0) {
      columns = (result.data?.cols ?? []).map((column) => {
        return column.name ?? column.display_name ?? "";
      });
    }

    rows.push(...rawRows.map((row) => row.map(cleanCell)));

    if (rawRows.length < limit) {
      break;
    }

    offset += limit;
  }

  return { columns, rows };
}

export async function fetchAdminBirthdays(config: MetabaseConfig, limit = DEFAULT_LIMIT) {
  const sessionToken = await authenticate(config);
  const source = await findUsersSource(config, sessionToken);
  const rows: CellValue[][] = [];
  let columns: string[] = [];
  let offset = 0;
  let previousFirstRow = "";

  while (true) {
    const result = await executeStructuredQuery(config, sessionToken, {
      database: source.databaseId,
      type: "query",
      query: {
        "source-table": source.tableId,
        fields: [
          ["field", source.fields.username, null],
          ["field", source.fields.name, null],
          ["field", source.fields.birthdate, null]
        ],
        filter: ["=", ["field", source.fields.isAdmin, null], true],
        limit,
        offset
      },
      display: "table"
    });

    const rawRows = result.data?.rows ?? [];

    if (columns.length === 0) {
      columns = (result.data?.cols ?? []).map((column) => {
        return column.name ?? column.display_name ?? "";
      });
    }

    rows.push(...rawRows.map((row) => row.map(cleanCell)));
    const firstRow = JSON.stringify(rawRows[0] ?? []);

    if (rawRows.length < limit) {
      break;
    }

    if (firstRow !== "" && firstRow === previousFirstRow) {
      break;
    }

    previousFirstRow = firstRow;
    offset += limit;
  }

  return { columns, rows };
}
