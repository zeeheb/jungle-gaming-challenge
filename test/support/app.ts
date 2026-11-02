import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON; `any` because assertions dig into arbitrary response shapes. */
  body: any;
}

export interface Api {
  get(path: string, headers?: Record<string, string>): Promise<ApiResponse>;
  /** For non-JSON responses, such as GET /metrics. */
  getText(path: string): Promise<{ status: number; body: string }>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  /** Sends `rawBody` untouched, for malformed JSON. */
  postRaw(path: string, rawBody: string, headers?: Record<string, string>): Promise<ApiResponse>;
}

export interface TestApp {
  api: Api;
  close(): Promise<void>;
}

/**
 * The whole application, real PostgreSQL and real HTTP on a random port.
 * `customize` may swap a provider (e.g. a shorter lock timeout); nothing is mocked.
 */
export async function startApp(
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestApp> {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { api: apiClient(url), close: () => app.close() };
}

function apiClient(baseUrl: string): Api {
  const send = async (method: string, path: string, rawBody?: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody,
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };
  return {
    get: (path, headers) => send('GET', path, undefined, headers),
    getText: async (path) => {
      const response = await fetch(`${baseUrl}${path}`);
      return { status: response.status, body: await response.text() };
    },
    post: (path, body, headers) => send('POST', path, JSON.stringify(body), headers),
    postRaw: (path, rawBody, headers) => send('POST', path, rawBody, headers),
  };
}
