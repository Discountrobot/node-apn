"use strict";

const EventEmitter = require("events");


const CLIENT_PRELUDE = new Buffer("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

module.exports = function(dependencies) {
  const tls = dependencies.tls;
  const protocol = dependencies.protocol;
  const debug = dependencies.debug;

  const noop = () => {};
  const noopLogger = {
    fatal: noop,
    error: noop,
    warn : noop,
    info : noop,
    debug: debug,
    trace: noop,

    child: function() { return this; }
  };

  function Endpoint(options) {
    EventEmitter.call(this);

    this.options = options;
    options.host = options.host || options.address;
    options.servername = options.address;

    this._acquiredStreamSlots = 0;
    this._maximumStreamSlots = 0;

    options.ALPNProtocols = ["h2"];

    this._connect();
    this._setupHTTP2Pipeline();
    this._healthCheckInterval = this._setupHTTP2HealthCheck();
  }

  Endpoint.prototype = Object.create(EventEmitter.prototype, {
    availableStreamSlots: {
      get: function() {
        return this._maximumStreamSlots - this._acquiredStreamSlots;
      }
    }
  });

  Endpoint.prototype._setupHTTP2Pipeline = function _setupHTTP2Pipeline() {
    const serializer = new protocol.Serializer(noopLogger.child("serializer"));
    const compressor = new protocol.Compressor(noopLogger.child("compressor"), "REQUEST");
    const deserializer = new protocol.Deserializer(noopLogger.child("deserializer"));
    const decompressor = new protocol.Decompressor(noopLogger.child("decompressor"), "RESPONSE");

    this._connection.pipe(compressor);
    compressor.pipe(serializer);
    serializer.pipe(this._socket);

    this._socket.pipe(deserializer);
    deserializer.pipe(decompressor);
    decompressor.pipe(this._connection);

    this._connection.on("RECEIVING_SETTINGS_HEADER_TABLE_SIZE", compressor.setTableSizeLimit.bind(compressor));
    this._connection.on("ACKNOWLEDGED_SETTINGS_HEADER_TABLE_SIZE", decompressor.setTableSizeLimit.bind(decompressor));

    this._connection.on("RECEIVING_SETTINGS_MAX_CONCURRENT_STREAMS", maxStreams => {
      this._maximumStreamSlots = maxStreams;
      this.emit("wakeup");
    });

    serializer.on("error", this.emit.bind(this, "error"));
    compressor.on("error", this.emit.bind(this, "error"));
    deserializer.on("error", this.emit.bind(this, "error"));
    decompressor.on("error", this.emit.bind(this, "error"));
  };

  Endpoint.prototype._connect = function connect() {
    this._socket = tls.connect(this.options);
    this._socket.on("secureConnect", this._connected.bind(this));
    this._socket.on("error", this.emit.bind(this, "error"));
    this._socket.write(CLIENT_PRELUDE);

    this._connection = new protocol.Connection(noopLogger, 1);
    this._connection.on("error", this.emit.bind(this, "error"));
    this._connection.on('peerError', this.emit.bind(this, 'error'));
  };

  Endpoint.prototype._connected = function connected() {
    this.emit("connect");
  };

  Endpoint.prototype._setupHTTP2HealthCheck = function healthcheck() {
    return setInterval(() => {
      let timeout = setTimeout(() => {
        this.emit("error", new Error("PING frame timed out!"));
      }, this.options.connectTimeout);
      this._connection.ping((data) => clearTimeout(timeout));
    }, 60 * 1000 * 2)
  };

  Endpoint.prototype.createStream = function createStream() {
    let stream = this._connection.createStream();

    this._acquiredStreamSlots += 1;
    stream.on("end", () => {
      stream = null;
      this._acquiredStreamSlots -= 1;
      this.emit("wakeup");
    });

    return stream;
  };

  Endpoint.prototype.destroy = function destroy() {
    clearInterval(this._healthCheckInterval);
    this._socket.destroy();
  };

  return Endpoint;
};
