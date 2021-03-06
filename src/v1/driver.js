/**
 * Copyright (c) 2002-2016 "Neo Technology,"
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Session from './session';
import Pool from './internal/pool';
import Integer from './integer';
import {connect} from "./internal/connector";
import StreamObserver from './internal/stream-observer';
import {newError, SERVICE_UNAVAILABLE} from "./error";

let READ = 'READ', WRITE = 'WRITE';
/**
 * A driver maintains one or more {@link Session sessions} with a remote
 * Neo4j instance. Through the {@link Session sessions} you can send statements
 * and retrieve results from the database.
 *
 * Drivers are reasonably expensive to create - you should strive to keep one
 * driver instance around per Neo4j Instance you connect to.
 *
 * @access public
 */
class Driver {
  /**
   * You should not be calling this directly, instead use {@link driver}.
   * @constructor
   * @param {string} url
   * @param {string} userAgent
   * @param {Object} token
   * @param {Object} config
   * @access private
   */
  constructor(url, userAgent = 'neo4j-javascript/0.0', token = {}, config = {}) {
    this._url = url;
    this._userAgent = userAgent;
    this._openSessions = {};
    this._sessionIdGenerator = 0;
    this._token = token;
    this._config = config;
    this._pool = new Pool(
      this._createConnection.bind(this),
      this._destroyConnection.bind(this),
      Driver._validateConnection.bind(this),
      config.connectionPoolSize
    );
  }

  /**
   * Create a new connection instance.
   * @return {Connection} new connector-api session instance, a low level session API.
   * @access private
   */
  _createConnection(url, release) {
    let sessionId = this._sessionIdGenerator++;
    let streamObserver = new _ConnectionStreamObserver(this);
    let conn = connect(url, this._config);
    conn.initialize(this._userAgent, this._token, streamObserver);
    conn._id = sessionId;
    conn._release = () => release(url, conn);

    this._openSessions[sessionId] = conn;
    return conn;
  }

  /**
   * Check that a connection is usable
   * @return {boolean} true if the connection is open
   * @access private
   **/
  static _validateConnection(conn) {
    return conn.isOpen();
  }

  /**
   * Dispose of a live session, closing any associated resources.
   * @return {Session} new session.
   * @access private
   */
  _destroyConnection(conn) {
    delete this._openSessions[conn._id];
    conn.close();
  }

  /**
   * Acquire a session to communicate with the database. The driver maintains
   * a pool of sessions, so calling this method is normally cheap because you
   * will be pulling a session out of the common pool.
   *
   * This comes with some responsibility - make sure you always call
   * {@link Session#close()} when you are done using a session, and likewise,
   * make sure you don't close your session before you are done using it. Once
   * it is returned to the pool, the session will be reset to a clean state and
   * made available for others to use.
   *
   * @param {String} mode of session - optional
   * @return {Session} new session.
   */
  session(mode) {
    let connectionPromise = this._acquireConnection(mode);
    connectionPromise.catch((err) => {
      if (this.onError && err.code === SERVICE_UNAVAILABLE) {
        this.onError(err);
      } else {
        //we don't need to tell the driver about this error
      }
    });
    return this._createSession(connectionPromise, (cb) => {
      // This gets called on Session#close(), and is where we return
      // the pooled 'connection' instance.

      // We don't pool Session instances, to avoid users using the Session
      // after they've called close. The `Session` object is just a thin
      // wrapper around Connection anyway, so it makes little difference.

      // Queue up a 'reset', to ensure the next user gets a clean
      // session to work with.

      connectionPromise.then( (conn) => {
        conn.reset();
        conn.sync();

        // Return connection to the pool
        conn._release();
      }).catch( () => {/*ignore errors here*/});

      // Call user callback
      if (cb) {
        cb();
      }
    });
  }

  //Extension point
  _acquireConnection(mode) {
   return Promise.resolve(this._pool.acquire(this._url));
  }

  //Extension point
  _createSession(connectionPromise, cb) {
    return new Session(connectionPromise, cb);
  }

  /**
   * Close all open sessions and other associated resources. You should
   * make sure to use this when you are done with this driver instance.
   * @return undefined
   */
  close() {
    for (let sessionId in this._openSessions) {
      if (this._openSessions.hasOwnProperty(sessionId)) {
        this._openSessions[sessionId].close();
      }
      this._pool.purgeAll();
    }
  }
}

/** Internal stream observer used for connection state */
class _ConnectionStreamObserver extends StreamObserver {
  constructor(driver) {
    super();
    this._driver = driver;
    this._hasFailed = false;
  }

  onError(error) {
    if (!this._hasFailed) {
      super.onError(error);
      if (this._driver.onError) {
        this._driver.onError(error);
      }
      this._hasFailed = true;
    }
  }

  onCompleted(message) {
    if (this._driver.onCompleted) {
      this._driver.onCompleted(message);
    }
  }
}



export {Driver, READ, WRITE}

export default Driver
