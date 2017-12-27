// Server-side renderer for our React code
import fs from 'fs';
const debug = require('debug')('hyperion:renderer');
import React from 'react';
import ReactDOM from 'react-dom/server';
import { ServerStyleSheet } from 'styled-components';
import {
  ApolloClient,
  createNetworkInterface,
  ApolloProvider,
  renderToStringWithData,
} from 'react-apollo';
import { StaticRouter } from 'react-router';
import { createStore } from 'redux';
import Helmet from 'react-helmet';
import * as graphql from 'graphql';
import Loadable from 'react-loadable';
import { getBundles } from 'react-loadable/webpack';
import Raven from 'shared/raven';
import stats from '../../build/react-loadable.json';

import getSharedApolloClientOptions from 'shared/graphql/apollo-client-options';
import { getHTML, createScriptTag } from './get-html';

// Browser shim has to come before any client imports
import './browser-shim';
const Routes = require('../../src/routes').default;
import { initStore } from '../../src/store';

const IN_MAINTENANCE_MODE =
  process.env.REACT_APP_MAINTENANCE_MODE === 'enabled';
const IS_PROD = process.env.NODE_ENV === 'production';
const FORCE_DEV = process.env.FORCE_DEV;

if (!IS_PROD || FORCE_DEV) console.log('Querying API at localhost:3001/api');

const renderer = (req, res) => {
  debug(`server-side render ${req.url}`);
  debug(`querying API at https://${req.hostname}/api`);
  // Create an Apollo Client with a local network interface
  const client = new ApolloClient({
    ssrMode: true,
    networkInterface: createNetworkInterface({
      uri:
        IS_PROD && !FORCE_DEV
          ? `https://${req.hostname}/api`
          : 'http://localhost:3001/api',
      opts: {
        // Send credentials on
        credentials: 'include',
        // Forward the cookies to the API so it can authenticate the user
        headers: {
          cookie: req.headers.cookie,
        },
      },
    }),
    ...getSharedApolloClientOptions(),
  });
  // Define the initial redux state
  const initialReduxState = {
    users: {
      currentUser: req.user,
    },
    dashboardFeed: {
      activeThread: req.query.t ? req.query.t : '',
      mountedWithActiveThread: req.query.t ? req.query.t : '',
      search: {
        isOpen: false,
      },
    },
  };
  // Create the Redux store
  const store = initStore(initialReduxState, {
    // Inject the server-side client's middleware and reducer
    middleware: [client.middleware()],
    reducers: {
      apollo: client.reducer(),
    },
  });
  let modules = [];
  const report = moduleName => {
    debug(`codesplitted module ${moduleName} used`);
    modules.push(moduleName);
  };
  const context = {};
  // The client-side app will instead use <BrowserRouter>
  const frontend = (
    <Loadable.Capture report={report}>
      <ApolloProvider store={store} client={client}>
        <StaticRouter location={req.url} context={context}>
          <Routes maintenanceMode={IN_MAINTENANCE_MODE} />
        </StaticRouter>
      </ApolloProvider>
    </Loadable.Capture>
  );
  // Initialise the styled-components stylesheet and wrap the app with it
  const sheet = new ServerStyleSheet();
  debug(`render frontend`);
  renderToStringWithData(sheet.collectStyles(frontend))
    .then(content => {
      if (context.url) {
        console.log('context ', context);
        debug('found redirect on frontend, redirecting');
        // Somewhere a `<Redirect>` was rendered, so let's redirect server-side
        res.redirect(301, context.url);
        return;
      }
      // Get the resulting data
      const state = store.getState();
      const helmet = Helmet.renderStatic();
      if (IN_MAINTENANCE_MODE) {
        debug('maintainance mode enabled, sending 503');
        res.status(503);
        res.set('Retry-After', 3600);
      } else {
        res.status(200);
      }
      const bundles = getBundles(stats, modules)
        // Create <script defer> tags from bundle objects
        .map(bundle =>
          createScriptTag({ src: `/${bundle.file.replace(/\.map$/, '')}` })
        )
        // Make sure only unique bundles are included
        .filter((value, index, self) => self.indexOf(value) === index);
      debug('compile and send html');
      const scriptTags = [...bundles].join('\n');
      debug(`script tags: ${scriptTags}`);
      // Compile the HTML and send it down
      res.send(
        getHTML({
          content,
          state,
          styleTags: sheet.getStyleTags(),
          metaTags:
            helmet.title.toString() +
            helmet.meta.toString() +
            helmet.link.toString(),
          scriptTags,
        })
      );
      res.end();
    })
    .catch(err => {
      console.error(err);
      Raven.captureException(err);
      res.status(500);
      res.send('Oops, something went wrong. Please try again!');
    });
};

export default renderer;