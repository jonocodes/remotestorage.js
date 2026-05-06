import EventHandling from './eventhandling';
import { Remote, RemoteBase, RemoteResponse, RemoteSettings } from './remote';
import RemoteStorage from './remotestorage';
interface GitHubConfig {
    owner: string;
    repo: string;
    clientId?: string;
    token?: string;
    branch?: string;
    root?: string;
}
declare class GitHub extends RemoteBase implements Remote {
    clientId: string;
    TOKEN_URL: string;
    token: string;
    userAddress: string;
    owner: string;
    repo: string;
    branch: string;
    root: string;
    private _writeQueue;
    _emit: any;
    constructor(rs: RemoteStorage);
    connect(): Promise<void>;
    configure(settings: RemoteSettings): Promise<void>;
    stopWaitingForToken(): void;
    get(path: string, options?: {
        ifNoneMatch?: string;
    }): Promise<RemoteResponse>;
    put(path: string, body: XMLHttpRequestBodyInit, contentType: string, options?: {
        ifMatch?: string;
        ifNoneMatch?: string;
    }): Promise<RemoteResponse>;
    'delete'(path: string, options?: {
        ifMatch?: string;
    }): Promise<RemoteResponse>;
    private _enqueueWrite;
    private _githubPath;
    private _contentsUrl;
    private _githubRequest;
    private _fetchUserLogin;
    private _getFile;
    private _listFolder;
    private _putFile;
    private _deleteFile;
    static _rs_init(rs: RemoteStorage): void;
    static _rs_supported(): boolean;
    static _rs_cleanup(rs: RemoteStorage): void;
}
interface GitHub extends EventHandling {
}
declare namespace GitHub {
    interface Config extends GitHubConfig {
    }
}
export = GitHub;
//# sourceMappingURL=github.d.ts.map