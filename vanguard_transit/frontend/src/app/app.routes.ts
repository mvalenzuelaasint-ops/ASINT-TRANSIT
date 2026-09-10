import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'planning/optimization',
  },
  // ----- Planificación operacional -----
  {
    path: 'planning/optimization',
    loadComponent: () =>
      import('./features/planning-optimization/planning-optimization.page').then((m) => m.PlanningOptimizationPage),
  },
  {
    path: 'planning/heuristic',
    loadComponent: () =>
      import('./features/planning-heuristic/planning-heuristic.page').then((m) => m.PlanningHeuristicPage),
  },
  {
    path: 'planning/fleet',
    loadComponent: () =>
      import('./features/planning-fleet/planning-fleet.page').then((m) => m.PlanningFleetPage),
  },
  // ----- Ejecución operacional -----
  {
    path: 'execution/management',
    loadComponent: () =>
      import('./features/execution-management/execution-management.page').then((m) => m.ExecutionManagementPage),
  },
  {
    path: 'execution/kpi',
    loadComponent: () => import('./features/execution-kpi/execution-kpi.page').then((m) => m.ExecutionKpiPage),
  },
  {
    path: 'execution/tasas',
    loadComponent: () => import('./features/execution-tasas/tasas.page').then((m) => m.TasasPage),
  },
  {
    path: 'execution/trayectos',
    loadComponent: () => import('./features/execution-trayectos/trayectos.page').then((m) => m.TrayectosPage),
  },
  // ----- Vistas anteriores (legacy) -----
  {
    path: 'dashboard',
    loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage),
  },
  {
    path: 'deadhead',
    loadComponent: () => import('./features/deadhead/deadhead.page').then((m) => m.DeadheadPage),
  },
  {
    path: 'routes',
    loadComponent: () => import('./features/route-planner/route-planner.page').then((m) => m.RoutePlannerPage),
  },
  {
    path: 'analytics',
    loadComponent: () => import('./features/analytics/analytics.page').then((m) => m.AnalyticsPage),
  },
  {
    path: '**',
    redirectTo: 'planning/optimization',
  },
];
