import { createBrowserRouter, Navigate, RouteObject } from 'react-router'

import Layout from './_layout'
import { navItems } from './_navigation'
import { AccountPage, InvitePage } from './fengwo/account'
import { PlansPage, OrdersPage } from './fengwo/commerce'
import {
  DashboardPage,
  NodesPage,
  RoutingPage,
  TrafficPage,
} from './fengwo/network'
import { AdvancedPage, ToolsPage } from './fengwo/tools'

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    children: [
      { path: '/', Component: DashboardPage },
      { path: '/plans', Component: PlansPage },
      { path: '/nodes', Component: NodesPage },
      { path: '/routing', Component: RoutingPage },
      { path: '/traffic', Component: TrafficPage },
      { path: '/orders', Component: OrdersPage },
      { path: '/invite', Component: InvitePage },
      { path: '/account', Component: AccountPage },
      { path: '/advanced', Component: AdvancedPage },
      { path: '/tools', Component: ToolsPage },
      { path: '/profiles', element: <Navigate to="/" replace /> },
      { path: '/settings', element: <Navigate to="/advanced" replace /> },
      { path: '/connections', element: <Navigate to="/routing" replace /> },
      { path: '/rules', element: <Navigate to="/routing?tab=rules" replace /> },
      ...navItems
        .filter((item) => ['/proxies', '/unlock', '/logs'].includes(item.path))
        .map(
          (item) =>
            ({
              path: item.path,
              Component: item.Component,
            }) as RouteObject,
        ),
    ],
  },
])
