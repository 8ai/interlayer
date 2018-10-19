let http = require('http');
let https = require('https');
let async = require('async');
let fs = require('fs');
//let WebSocket = require('ws');
let logger = require('./logger.js');
let init = null;
let helpers = null;

let defLog = null;
let instantShutdownDelay;
let serverStat = {
  started: null,
  pings: []
};

process.on('uncaughtException', err => (defLog && defLog.c || console.error)(Date.now(), 'Caught exception:', err));

exports.start = (paths, conf) => {
  global.logger = logger.logger(conf.logPath, conf.debug, conf.pingponglog);
  defLog = global.logger.create('SRV');

  helpers = require('./helpers');
  init = require('./init.js')(paths, conf);
  if(conf.instantShutdownDelay){
    instantShutdownDelay = conf.instantShutdownDelay;
  }
  
  let server;
  if(conf.secure){
    if(!conf.secure.key || !conf.secure.cert){
      throw 'SECURE.KEY & SECURE.CERT MUST TO BE FILLED';
    }

    let opts = {
      key: fs.readFileSync(conf.secure.key),
      cert: fs.readFileSync(conf.secure.cert)
    };
    server = https.createServer(opts, requestFunc);
  }
  else{
    server = http.createServer(requestFunc);
  }
  server.listen(conf.port || 8080);
  serverStat.started = new Date();

  process.on('exit', function(){
    if(gracefulShutdownInited){
      return process.exit();
    }

    console.log('exit event', process.exitCode, serverStat);
    graceful_shutdown();
  });
  process.on('SIGINT', () => {
    defLog.i('SIGINT event', process.exitCode);
    graceful_shutdown(1);
  });
  process.on('SIGTERM', () => {
    defLog.ilog('SIGTERM event', process.exitCode);
    graceful_shutdown(1);
  });
  // let websocket;//https://github.com/websockets/ws#server-example
  // if(conf.websocket == true){
  //  websocket = new WebSocket.Server({server});
  // }

  defLog.i('server started on port: ' + (conf.port || 8080), conf.secure && 'https');
};

function requestFunc(request, response){
  if(gracefulShutdownInited){
    response.writeHead(503, {
      'Retry-After': init.config.retryAter || 10
    });
    response.end('Server Unavailable Or In Reboot');
    return;
  }

  let requestObject = init.reconstructRequest(request, response);
  let log = requestObject.modifyLog(defLog);
  let reqStart = Date.now();
  
  let module = init.getModule(requestObject.path);
  
  if(!module){
    return init.serve(requestObject, (err, data) => {
      if(data){
        log.i(requestObject.ip, 'SERVE', requestObject.path);
        return requestObject.end(data, 200, {'Content-Type': helpers.mime(requestObject.path)});
      }

      log.i('BAD', requestObject.ip, 'REQ: ' + requestObject.path, 'FROM: ' + (requestObject.headers.referer || '---'),);
      return requestObject.end('<title>' + requestObject.i18n('title_error_404', 'Not found') + '</title>Error 404, Not found', 404);
    });
  }

  let disableNagleAlgoritm = false;
  if(init.config.disableNagleAlgoritm == true || module.meta.disableNagleAlgoritm == true){
    disableNagleAlgoritm = true;
  }
  if(module.meta.disableNagleAlgoritm == false){
    disableNagleAlgoritm = false;
  }
  if(disableNagleAlgoritm == true){
    request.socket.setNoDelay(); // Disable Nagle's algorytm
  }

  /*if(!helpers.auth(module.meta, requestObject)){
    return requestObject.end('Access denied', 401, {'WWW-Authenticate': 'Basic realm="example"'});
  }*/ // not working yet

  async.auto({
    post: cb => helpers.parsePost(requestObject, request, cb),
    middleware: ['post', (res, cb) => {
      let middlewareTimeout = init.config.middlewareTimeout || module.meta.middlewareTimeout || 10;
      init.middleware(requestObject, module.meta, helpers.timeout({timeout: middlewareTimeout}, {}, (e, data, code, headers) => {
        if(e){
          res.data = {error: e};
          res.code = code || 200;
          res.headers = headers || {'Content-Type': 'application/json'};
          res.middlewareError = true;
          return cb(null, true);
        }

        cb();
      }));
    }],
    prerun: ['middleware', (res, cb) => {
      if(!module.meta.prerun || res.middleware){
        return cb();
      }

      module.meta.prerun(requestObject, module.meta, cb);
    }],
    module: ['post', 'prerun', (res, cb) => {
      if(res.middleware){
        return cb();
      }

      let poolId = requestObject.params.poolingId || requestObject.post.poolingId;
      let withPool = requestObject.params.withPooling || requestObject.post.withPooling;
      let next = helpers.timeout(init.config, module.meta, (e, data, code, headers, type) => {
        if(e){
          data = {error: e};
          code = code || 200;
          headers = headers || {'Content-Type': 'application/json'};
          type = null;
        }

        res.data = data;
        res.code = code || 200;
        res.headers = headers || {};
        res.type = type;
        cb();
      });

      if(poolId){
        if(!init.pools[poolId]){
          return next('BAD_POOL_ID');
        }

        return next(null, init.pools[poolId]);
      }
      else if(withPool){
        let id = helpers.generateId();
        init.pools[id] = {
          poolingId: id
        };

        next(null, init.pools[id]);//eslint-disable-line callback-return
        next = (err, res) => {
          init.pools[id] = err || res;
        };
      }

      try{
        return module.func(requestObject, next);
      }
      catch(e){
        log.e(e);
        return next(e);
      }
    }],
    json: ['module', (res, cb) =>{
      if(module.meta.toJson || module.meta.contentType == 'json' || res.headers['Content-Type'] == 'application/json'){
        helpers.toJson(res);
      }

      cb();
    }]
  },
  (err, res) => {
    if(module.meta && module.meta.skipRequestLog !== true){
      log.i(
        requestObject.ip,
        'REQ: ' + requestObject.path,
        'FROM: ' + (requestObject.headers.referer || '---'),
        'GET: ' + helpers.clearObj(requestObject.params, ['token']),
        'POST: ' + helpers.clearObj(requestObject.post, ['token']),
        'len: ' + (res.data && res.data.length),
        'time: ' + ((Date.now() - reqStart) / 1000) + 's'
      );
    }

    if(err){
      return requestObject.error(err);
    }

    if(!requestObject.responseFree){
      requestObject.end(res.data, res.code, res.headers, res.type);
    }
  });
}

global.intervals = {
  _si: setInterval(() => {
    for(let i in global.intervals._funcs){
      if(!global.intervals._funcs.hasOwnProperty(i)){
        continue;
      }

      if(global.intervals._funcs[i].runafter && Date.now() < global.intervals._funcs[i].runafter){
        continue;
      }

      if(global.intervals._funcs[i].runafter){
        global.intervals._funcs[i].runafter = Date.now() + global.intervals._funcs[i].t * 1000;
      }

      if(global.intervals._funcs[i].disabled){
        continue;
      }

      global.intervals._funcs[i].f(() => {
        global.intervals.del(global.intervals._funcs[i].key);
      });
    }
  }, 1000),
  _funcs: [],
  add: function(f, t){
    let key = Math.random() * Date.now();
    this._funcs.push({
      key: key,
      f: f,
      t: t,
      runafter: t ? Date.now() + t * 1000 : null
    });
  },
  del: function(key){
    let ind = this._funcs.reduce((r,f,ind)=>{
      if(f.key == key){
        r = ind;
      }
      return r;
    }, -1);
    this._funcs.splice(ind, 1);
    return key;
  },
  disable: function(key, val){
    this._funcs.map(f=>{
      if(f.key == key){
        if(val == false){
          f.disabled = false;
        }
        else{
          f.disabled = true;
        }
      }
    });
  }
};

process.on('message', obj=> {
  switch(obj.type){
  case 'start': 
    exports.start(obj.paths, obj.config);
    break;
  case 'ping':
    if(process.send){
      process.send({
        type: 'pong',
        id: obj.id
      });
      defLog.pp('server obtain ping');
      defLog.pp('server send pong');
      startPing();
    }
    break;
  case 'pong':
    let ind = serverStat.pings.indexOf(obj.id);
    if(ind > -1){
      serverStat.pings.splice(ind, 1);
    }
    defLog.pp('server obtain pong');
    break;
  case 'reload':
    defLog.i('reload command');
    graceful_shutdown(0);
    break;
  case 'exit':
    defLog.i('exit command');
    graceful_shutdown(1);
    break;
  }

  if(obj == 'shutdown') {
    defLog.i('process message shutdown');
    graceful_shutdown(1);
  }
});

// only if this node in cluster  
function startPing(){
  if(startPing.started){
    return;
  }

  startPing.started = true;
  defLog.d('start ping-pong with cluster');

  global.intervals.add((deleteInterval) => {
    if(serverStat.pings.length > 2){
      deleteInterval();
      defLog.c('cluster not answered');
      graceful_shutdown(0);
      return;
    }

    let ping = {
      type: 'ping',
      id: Date.now()
    };
    serverStat.pings.push(ping.id);

    process.send(ping);
    defLog.pp('server send ping');
  }, 1);
}
let gracefulShutdownInited;
function graceful_shutdown(code){
  if(gracefulShutdownInited){
    return;
  }

  if(!helpers || !Object.keys(helpers.processLocks).length){
    process.exit(code);
    return;
  }

  gracefulShutdownInited = Date.now();
  let si = setInterval(()=>{
    if(!Object.keys(helpers.processLocks).length || Date.now() - gracefulShutdownInited >= instantShutdownDelay || 1500){
      process.exit(code);
      clearInterval(si);
    }
  }, 50);
}