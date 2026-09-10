import { AsyncPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, signal, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import * as L from 'leaflet';
import { catchError, combineLatest, map, of } from 'rxjs';

import { ActivityItem, DashboardKpis } from '../../core/api.models';
import { DashboardApiService } from '../../core/dashboard-api.service';
import { downloadTextFile, toCsv } from '../../shared/download-file';
import { MetricCardComponent } from '../../shared/metric-card.component';
import { StatusBadgeComponent } from '../../shared/status-badge.component';

const FALLBACK_KPIS: DashboardKpis = {
  activeFleet: { value: 1248, unit: 'Vehículos', trend: '+12.4% vs ciclo anterior' },
  efficiencyRate: { value: 94.2, unit: '%', target: 92.0 },
  fuelConsumption: { value: 38.4, unit: 'L/100km', trend: '-2.1% optimización' },
  deadheadDistance: { value: 412, unit: 'km', alert: 'Crítico: Zona Alfa' },
};

const FALLBACK_ACTIVITY: readonly ActivityItem[] = [
  {
    id: 1,
    type: 'error',
    title: 'Retraso de Ruta: Línea 42',
    description: 'Congestión en el Sector 7 causando 12 min de retraso. Se recomienda redirección.',
    time: '02:14 PM',
  },
  {
    id: 2,
    type: 'success',
    title: 'Recálculo en vacío completado',
    description: 'El motor de optimización redujo la distancia total en 14 km hoy.',
    time: '01:55 PM',
  },
  {
    id: 3,
    type: 'info',
    title: 'Expansión de flota',
    description: '4 nuevas unidades eléctricas integradas en la rotación de servicio activo.',
    time: '11:30 AM',
  },
];

const EXTRA_ACTIVITY: readonly ActivityItem[] = [
  {
    id: 4,
    type: 'success',
    title: 'Carga programada',
    description: 'Se reservaron 6 puntos de carga para buses eléctricos en horario valle.',
    time: '10:42 AM',
  },
  {
    id: 5,
    type: 'info',
    title: 'Turnos sincronizados',
    description: 'El planificador actualizó bloques de conducción para el corredor central.',
    time: '09:18 AM',
  },
];

type DashboardAction = 'shifts' | 'charge' | 'recalculate' | 'report';
type FleetLayer = 'thermal' | 'traffic';
type VehicleStatus = 'on-time' | 'delayed' | 'charging';

interface LiveVehicle {
  readonly id: string;
  readonly line: string;
  readonly status: VehicleStatus;
  readonly lat: number;
  readonly lng: number;
  readonly load: number;
  readonly battery: number;
  readonly delay: string;
  readonly heading: number;
}

const LIVE_VEHICLES: readonly LiveVehicle[] = [
  { id: 'VEH-774', line: 'Línea 402-A', status: 'on-time', lat: -33.4372, lng: -70.6506, load: 72, battery: 88, delay: '+00:20', heading: 45 },
  { id: 'VEH-218', line: 'Línea 110-C', status: 'delayed', lat: -33.4569, lng: -70.6483, load: 91, battery: 61, delay: '+04:10', heading: 170 },
  { id: 'VEH-905', line: 'Línea 99-Z', status: 'on-time', lat: -33.4277, lng: -70.6125, load: 54, battery: 79, delay: '-00:45', heading: 260 },
  { id: 'VEH-611', line: 'Expreso Puerto', status: 'charging', lat: -33.4694, lng: -70.7072, load: 18, battery: 42, delay: 'Carga', heading: 310 },
  { id: 'VEH-332', line: 'Bucle Industrial', status: 'on-time', lat: -33.489, lng: -70.6358, load: 66, battery: 73, delay: '+01:05', heading: 90 },
];

const TRAFFIC_CORRIDORS: readonly { coordinates: L.LatLngExpression[]; color: string; weight: number }[] = [
  { coordinates: [[-33.4372, -70.6506], [-33.4569, -70.6483], [-33.489, -70.6358]], color: '#c8102e', weight: 5 },
  { coordinates: [[-33.4277, -70.6125], [-33.4372, -70.6506], [-33.4694, -70.7072]], color: '#f5a800', weight: 4 },
  { coordinates: [[-33.4694, -70.7072], [-33.4569, -70.6483], [-33.4277, -70.6125]], color: '#6452a2', weight: 4 },
];

const THERMAL_ZONES: readonly { center: L.LatLngExpression; radius: number; color: string; label: string }[] = [
  { center: [-33.4569, -70.6483], radius: 850, color: '#c8102e', label: 'Alta demanda centro' },
  { center: [-33.4372, -70.6506], radius: 620, color: '#f5a800', label: 'Nodo intermodal' },
  { center: [-33.4277, -70.6125], radius: 740, color: '#2f6fb2', label: 'Flujo oriente' },
];

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [AsyncPipe, NgClass, MetricCardComponent, StatusBadgeComponent],
  templateUrl: './dashboard.page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage implements OnDestroy {
  readonly activeLayer = signal<FleetLayer>('thermal');
  readonly showAllActivity = signal(false);
  readonly lastAction = signal('Monitoreo en tiempo real activo');
  readonly vehicles = LIVE_VEHICLES;
  readonly selectedVehicle = signal<LiveVehicle>(LIVE_VEHICLES[0]);

  private map?: L.Map;
  private readonly mapLayers: Partial<Record<'vehicles' | 'operations', L.LayerGroup>> = {};

  @ViewChild('fleetMap')
  set fleetMapElement(element: ElementRef<HTMLDivElement> | undefined) {
    if (!element || this.map) {
      return;
    }

    this.initializeMap(element.nativeElement);
  }

  readonly viewModel$ = combineLatest({
    kpis: this.dashboardApi.getKpis().pipe(catchError(() => of(FALLBACK_KPIS))),
    activity: this.dashboardApi.getActivity().pipe(catchError(() => of([...FALLBACK_ACTIVITY]))),
  }).pipe(
    map(({ kpis, activity }) => ({
      kpis,
      activity: activity.map((item) => this.normalizeActivity(item)),
    })),
  );

  readonly quickActions: readonly { icon: string; label: string; action: DashboardAction }[] = [
    { icon: 'schedule', label: 'Optimizar turnos', action: 'shifts' },
    { icon: 'ev_station', label: 'Registrar carga', action: 'charge' },
    { icon: 'history', label: 'Recalcular ruta', action: 'recalculate' },
    { icon: 'description', label: 'Generar informe', action: 'report' },
  ];

  constructor(
    private readonly dashboardApi: DashboardApiService,
    private readonly router: Router,
    private readonly zone: NgZone,
  ) {}

  ngOnDestroy(): void {
    this.map?.remove();
  }

  setLayer(layer: FleetLayer): void {
    this.activeLayer.set(layer);
    this.lastAction.set(layer === 'thermal' ? 'Capa térmica activada' : 'Capa de tráfico activada');
    this.renderOperationalLayer();
  }

  focusVehicle(vehicle: LiveVehicle): void {
    this.selectedVehicle.set(vehicle);
    this.lastAction.set(`${vehicle.id} seleccionado en ${vehicle.line}`);
    this.map?.flyTo([vehicle.lat, vehicle.lng], Math.max(this.map.getZoom(), 13), { duration: 0.7 });
  }

  toggleActivity(): void {
    this.showAllActivity.update((value) => !value);
  }

  handleQuickAction(action: DashboardAction, kpis: DashboardKpis): void {
    if (action === 'shifts') {
      void this.router.navigate(['/routes'], { queryParams: { mode: 'weekly' } });
      return;
    }

    if (action === 'recalculate') {
      void this.router.navigate(['/deadhead']);
      return;
    }

    if (action === 'charge') {
      this.lastAction.set('Registro de carga creado para 6 buses eléctricos');
      return;
    }

    const csv = toCsv([
      ['Métrica', 'Valor', 'Unidad', 'Detalle'],
      ['Flota activa', String(kpis.activeFleet.value), kpis.activeFleet.unit ?? '', kpis.activeFleet.trend ?? ''],
      ['Tasa de eficiencia', String(kpis.efficiencyRate.value), kpis.efficiencyRate.unit ?? '', `Objetivo ${kpis.efficiencyRate.target ?? 92}%`],
      ['Consumo combustible', String(kpis.fuelConsumption.value), kpis.fuelConsumption.unit ?? '', kpis.fuelConsumption.trend ?? ''],
      ['Distancia en vacío', String(kpis.deadheadDistance.value), kpis.deadheadDistance.unit ?? '', kpis.deadheadDistance.alert ?? ''],
    ]);
    downloadTextFile('resumen-operacional.csv', csv);
    this.lastAction.set('Informe operacional descargado');
  }

  visibleActivity(activity: readonly ActivityItem[]): readonly ActivityItem[] {
    return this.showAllActivity() ? [...activity, ...EXTRA_ACTIVITY] : activity.slice(0, 3);
  }

  activityTone(type: ActivityItem['type']): 'primary' | 'tertiary' | 'error' {
    if (type === 'error') {
      return 'error';
    }
    if (type === 'success') {
      return 'primary';
    }
    return 'tertiary';
  }

  activityIcon(type: ActivityItem['type']): string {
    return {
      error: 'priority_high',
      success: 'check_circle',
      info: 'commute',
    }[type];
  }

  vehicleStatusLabel(status: VehicleStatus): string {
    return {
      'on-time': 'En tiempo',
      delayed: 'Demorado',
      charging: 'En carga',
    }[status];
  }

  vehicleStatusClass(status: VehicleStatus): string {
    return {
      'on-time': 'text-primary',
      delayed: 'text-error',
      charging: 'text-tertiary',
    }[status];
  }

  private normalizeActivity(item: ActivityItem): ActivityItem {
    return {
      ...item,
      title: item.title
        .replace('Route Delay', 'Retraso de Ruta')
        .replace('Deadhead Recalc Complete', 'Recálculo en vacío completado')
        .replace('Fleet Expansion', 'Expansión de flota'),
      description: item.description
        .replace('Congestion at Sector 7 causing 12min backup. Redirect recommended.', 'Congestión en el Sector 7 causando 12 min de retraso. Se recomienda redirección.')
        .replace('Optimization engine reduced total distance by 14km today.', 'El motor de optimización redujo la distancia total en 14 km hoy.')
        .replace('4 new electric units integrated into active duty rotation.', '4 nuevas unidades eléctricas integradas en la rotación de servicio activo.'),
    };
  }

  private initializeMap(element: HTMLDivElement): void {
    this.zone.runOutsideAngular(() => {
      const map = L.map(element, {
        attributionControl: false,
        scrollWheelZoom: true,
        zoomControl: false,
      }).setView([-33.4489, -70.6693], 12);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      }).addTo(map);

      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.control
        .attribution({ position: 'bottomleft', prefix: false })
        .addAttribution('&copy; OpenStreetMap contributors &copy; CARTO')
        .addTo(map);

      this.map = map;
      this.mapLayers.operations = L.layerGroup().addTo(map);
      this.mapLayers.vehicles = L.layerGroup().addTo(map);
      this.renderVehicles();
      this.renderOperationalLayer();
      map.fitBounds(L.latLngBounds(LIVE_VEHICLES.map((vehicle) => [vehicle.lat, vehicle.lng] as L.LatLngTuple)), { padding: [42, 42] });

      window.setTimeout(() => map.invalidateSize(), 0);
    });
  }

  private renderVehicles(): void {
    const layer = this.mapLayers.vehicles;
    if (!layer) {
      return;
    }

    layer.clearLayers();
    LIVE_VEHICLES.forEach((vehicle) => {
      const marker = L.marker([vehicle.lat, vehicle.lng], {
        icon: L.divIcon({
          className: '',
          html: `
            <button class="fleet-marker fleet-marker--${vehicle.status}" style="--heading:${vehicle.heading}deg; --reverse-heading:${vehicle.heading * -1}deg" aria-label="${vehicle.id}">
              <span class="material-symbols-outlined">directions_bus</span>
            </button>
          `,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      });

      marker.bindPopup(`
        <strong>${vehicle.id}</strong><br>
        ${vehicle.line}<br>
        Carga: ${vehicle.load}%<br>
        Batería: ${vehicle.battery}%<br>
        Estado: ${this.vehicleStatusLabel(vehicle.status)}
      `);
      marker.on('click', () => this.zone.run(() => this.focusVehicle(vehicle)));
      marker.addTo(layer);
    });
  }

  private renderOperationalLayer(): void {
    const layer = this.mapLayers.operations;
    if (!layer) {
      return;
    }

    layer.clearLayers();
    if (this.activeLayer() === 'thermal') {
      THERMAL_ZONES.forEach((zone) => {
        L.circle(zone.center, {
          radius: zone.radius,
          color: zone.color,
          fillColor: zone.color,
          fillOpacity: 0.18,
          opacity: 0.72,
          weight: 1,
        })
          .bindTooltip(zone.label, { direction: 'top' })
          .addTo(layer);
      });
      return;
    }

    TRAFFIC_CORRIDORS.forEach((corridor) => {
      L.polyline(corridor.coordinates, {
        color: corridor.color,
        opacity: 0.9,
        weight: corridor.weight,
      }).addTo(layer);
    });
  }
}
