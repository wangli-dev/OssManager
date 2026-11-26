export namespace config {
	
	export class Connection {
	    name: string;
	    displayName: string;
	    type: string;
	    endpoint: string;
	
	    static createFrom(source: any = {}) {
	        return new Connection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.displayName = source["displayName"];
	        this.type = source["type"];
	        this.endpoint = source["endpoint"];
	    }
	}
	export class Settings {
	    rcloneConfig: string;
	    fileManager: string;
	    theme: string;
	    cacheDirectory: string;
	    dirCacheTime: string;
	    vfsCacheMaxSize: string;
	    vfsCacheMaxAge: string;
	    bufferSize: string;
	    maxConcurrentTransfers: number;
	    downloadStreams: number;
	    downloadDirectory: string;
	    dragMode: string;
	    autoSizeEnabled: boolean;
	    autoSizeDelay: number;
	    autoSizeInterval: number;
	    serverModtimeRemotes: string[];
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rcloneConfig = source["rcloneConfig"];
	        this.fileManager = source["fileManager"];
	        this.theme = source["theme"];
	        this.cacheDirectory = source["cacheDirectory"];
	        this.dirCacheTime = source["dirCacheTime"];
	        this.vfsCacheMaxSize = source["vfsCacheMaxSize"];
	        this.vfsCacheMaxAge = source["vfsCacheMaxAge"];
	        this.bufferSize = source["bufferSize"];
	        this.maxConcurrentTransfers = source["maxConcurrentTransfers"];
	        this.downloadStreams = source["downloadStreams"];
	        this.downloadDirectory = source["downloadDirectory"];
	        this.dragMode = source["dragMode"];
	        this.autoSizeEnabled = source["autoSizeEnabled"];
	        this.autoSizeDelay = source["autoSizeDelay"];
	        this.autoSizeInterval = source["autoSizeInterval"];
	        this.serverModtimeRemotes = source["serverModtimeRemotes"];
	    }
	}

}

export namespace download {
	
	export class Record {
	    time: string;
	    remote: string;
	    name: string;
	    path: string;
	    localPath: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new Record(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.time = source["time"];
	        this.remote = source["remote"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.localPath = source["localPath"];
	        this.size = source["size"];
	    }
	}

}

export namespace local {
	
	export class Drive {
	    root: string;
	    label: string;
	    kind: string;
	
	    static createFrom(source: any = {}) {
	        return new Drive(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	    }
	}
	export class Entry {
	    name: string;
	    isDir: boolean;
	    size: number;
	    modTime: string;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.isDir = source["isDir"];
	        this.size = source["size"];
	        this.modTime = source["modTime"];
	    }
	}

}

export namespace main {
	
	export class AboutInfo {
	    appVersion: string;
	    rcloneVersion: string;
	    configPath: string;
	    dataDir: string;
	    logPath: string;
	
	    static createFrom(source: any = {}) {
	        return new AboutInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.appVersion = source["appVersion"];
	        this.rcloneVersion = source["rcloneVersion"];
	        this.configPath = source["configPath"];
	        this.dataDir = source["dataDir"];
	        this.logPath = source["logPath"];
	    }
	}
	export class TextFile {
	    text: string;
	    localPath: string;
	
	    static createFrom(source: any = {}) {
	        return new TextFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.localPath = source["localPath"];
	    }
	}
	export class UpdateInfo {
	    current: string;
	    latest: string;
	    url: string;
	    hasUpdate: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.url = source["url"];
	        this.hasUpdate = source["hasUpdate"];
	    }
	}

}

export namespace policy {
	
	export class Grant {
	    grantee: string;
	    type: string;
	    permission: string;
	
	    static createFrom(source: any = {}) {
	        return new Grant(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.grantee = source["grantee"];
	        this.type = source["type"];
	        this.permission = source["permission"];
	    }
	}
	export class ACL {
	    owner: string;
	    grants: Grant[];
	
	    static createFrom(source: any = {}) {
	        return new ACL(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.owner = source["owner"];
	        this.grants = this.convertValues(source["grants"], Grant);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace rclonefs {
	
	export class Entry {
	    name: string;
	    isDir: boolean;
	    size: number;
	    modTime: string;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.isDir = source["isDir"];
	        this.size = source["size"];
	        this.modTime = source["modTime"];
	    }
	}

}

export namespace remote {
	
	export class Definition {
	    name: string;
	    displayName: string;
	    type: string;
	    endpoint: string;
	    account: string;
	    secret: string;
	    region: string;
	
	    static createFrom(source: any = {}) {
	        return new Definition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.displayName = source["displayName"];
	        this.type = source["type"];
	        this.endpoint = source["endpoint"];
	        this.account = source["account"];
	        this.secret = source["secret"];
	        this.region = source["region"];
	    }
	}

}

export namespace transfer {
	
	export class Task {
	    id: string;
	    name: string;
	    path: string;
	    localPath: string;
	    total: number;
	    done: number;
	    speed: number;
	    status: string;
	    error: string;
	    started: string;
	    elapsedMs: number;
	
	    static createFrom(source: any = {}) {
	        return new Task(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.localPath = source["localPath"];
	        this.total = source["total"];
	        this.done = source["done"];
	        this.speed = source["speed"];
	        this.status = source["status"];
	        this.error = source["error"];
	        this.started = source["started"];
	        this.elapsedMs = source["elapsedMs"];
	    }
	}

}

