import { NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}

interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: 'Planificación operacional',
    items: [
      { path: '/planning/optimization', label: 'Por optimización', shortLabel: 'Optimización', icon: 'tune', keywords: ['optimización', 'solver', 'lineal', 'entera', 'plan'] },
      { path: '/planning/heuristic', label: 'Por heurística', shortLabel: 'Heurística', icon: 'extension', keywords: ['heurística', 'reglas', 'algoritmo', 'aproximado', 'plan'] },
      { path: '/planning/fleet', label: 'Flota planificada (GTFS)', shortLabel: 'Flota GTFS', icon: 'directions_bus', keywords: ['gtfs', 'flota', 'planificada', 'schedule', 'buses'] },
    ],
  },
  {
    title: 'Ejecución operacional',
    items: [
      { path: '/execution/management', label: 'Gestión (WhatsApp)', shortLabel: 'Gestión', icon: 'sms', keywords: ['gestión', 'whatsapp', 'bot', 'conductores', 'comunicación'] },
      { path: '/execution/kpi', label: 'Control de gestión (KPI)', shortLabel: 'KPI', icon: 'monitoring', keywords: ['kpi', 'control', 'indicadores', 'desempeño'] },
      { path: '/execution/tasas', label: 'Tasas de ocupación', shortLabel: 'Tasas', icon: 'groups', keywords: ['tasas', 'ocupación', 'demanda', 'pasajeros', 'contadores'] },
      { path: '/execution/trayectos', label: 'Trayectos realizados', shortLabel: 'Trayectos', icon: 'route', keywords: ['trayectos', 'gps', 'recorridos', 'buses', 'mapas', 'gráficos'] },
    ],
  },
  {
    title: 'Vistas anteriores',
    items: [
      { path: '/dashboard', label: 'Panel de Control', shortLabel: 'Flota', icon: 'dashboard', keywords: ['kpi', 'flota', 'actividad', 'mapa', 'panel'] },
      { path: '/deadhead', label: 'Movimientos en Vacío', shortLabel: 'Operaciones', icon: 'calculate', keywords: ['calcular', 'vacío', 'combustible', 'co2'] },
      { path: '/routes', label: 'Planificación de Rutas', shortLabel: 'Rutas', icon: 'route', keywords: ['rutas', 'horarios', 'conductores'] },
      { path: '/analytics', label: 'Analítica Operacional', shortLabel: 'Analítica', icon: 'analytics', keywords: ['análisis', 'costos', 'csv', 'reportes'] },
    ],
  },
];

const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

const NOTIFICATIONS = [
  { tone: 'error', title: 'Ruta 42 con retraso', detail: 'Sector 7 supera el umbral de congestión.' },
  { tone: 'primary', title: 'Cálculo actualizado', detail: 'La optimización redujo 14 km en vacío.' },
  { tone: 'tertiary', title: 'Nueva unidad integrada', detail: '4 buses eléctricos listos para rotación.' },
] as const;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgClass, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly navItems = NAV_ITEMS;
  readonly navGroups = NAV_GROUPS;
  readonly primaryNavItems = NAV_GROUPS.filter((group) => group.title !== 'Vistas anteriores').flatMap((group) => group.items);
  readonly notifications = NOTIFICATIONS;
  readonly mobileMenuOpen = signal(false);
  readonly searchQuery = signal('');
  readonly notificationsOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly supportOpen = signal(false);
  readonly logsOpen = signal(false);
  readonly compactMode = signal(false);
  readonly reduceMotion = signal(false);
  readonly toast = signal('');
  readonly currentPath = signal(this.router.url);
  readonly activeLabel = computed(() => {
    const item = this.navItems.find((navItem) => this.currentPath().startsWith(navItem.path));
    return item?.shortLabel ?? 'Operaciones';
  });
  readonly searchResults = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (query.length < 2) {
      return [];
    }

    return this.navItems.filter((item) => {
      const haystack = [item.label, item.shortLabel, ...item.keywords].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  });

  constructor(private readonly router: Router) {
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd)).subscribe((event) => {
      this.currentPath.set(event.urlAfterRedirects);
      this.mobileMenuOpen.set(false);
    });
  }

  toggleMobileMenu(): void {
    this.mobileMenuOpen.update((open) => !open);
  }

  updateSearch(value: string): void {
    this.searchQuery.set(value);
  }

  goToFirstSearchResult(): void {
    const [firstResult] = this.searchResults();
    if (firstResult) {
      this.navigateTo(firstResult.path);
    }
  }

  navigateTo(path: string): void {
    void this.router.navigateByUrl(path);
    this.searchQuery.set('');
    this.closePanels();
  }

  toggleNotifications(): void {
    this.notificationsOpen.update((open) => !open);
    this.settingsOpen.set(false);
    this.supportOpen.set(false);
    this.logsOpen.set(false);
  }

  toggleSettings(): void {
    this.settingsOpen.update((open) => !open);
    this.notificationsOpen.set(false);
    this.supportOpen.set(false);
    this.logsOpen.set(false);
  }

  openSupport(): void {
    this.supportOpen.set(true);
    this.logsOpen.set(false);
    this.notificationsOpen.set(false);
    this.settingsOpen.set(false);
  }

  openLogs(): void {
    this.logsOpen.set(true);
    this.supportOpen.set(false);
    this.notificationsOpen.set(false);
    this.settingsOpen.set(false);
  }

  copySupportCode(): void {
    const supportCode = `ASINT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-OPS`;
    void navigator.clipboard?.writeText(supportCode);
    this.showToast(`Código copiado: ${supportCode}`);
  }

  showToast(message: string): void {
    this.toast.set(message);
    window.setTimeout(() => this.toast.set(''), 2600);
  }

  private closePanels(): void {
    this.notificationsOpen.set(false);
    this.settingsOpen.set(false);
    this.supportOpen.set(false);
    this.logsOpen.set(false);
  }
}
