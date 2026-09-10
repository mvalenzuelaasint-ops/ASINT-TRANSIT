import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { IndicatorRunnerComponent, RunnerField } from './indicator-runner.component';

type KpiTab = 'icf' | 'ip' | 'ir';

@Component({
  selector: 'app-execution-kpi',
  standalone: true,
  imports: [IndicatorRunnerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Ejecución operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Control de gestión (KPI)</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Indicadores clave de desempeño operacional: cumplimiento de frecuencia (ICF), puntualidad (IP) y regularidad (IR).
        </p>
      </header>

      <!-- Pestañas -->
      <div class="mb-6 flex gap-1 rounded-xl bg-surface-container p-1">
        @for (tab of tabs; track tab.id) {
          <button
            class="flex-1 rounded-lg px-4 py-2 font-label text-xs font-bold uppercase tracking-widest transition-colors"
            [class]="activeTab() === tab.id
              ? 'bg-surface text-primary shadow-sm'
              : 'text-on-surface-variant hover:text-on-surface'"
            type="button"
            (click)="activeTab.set(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Contenido por pestaña -->
      @if (activeTab() === 'icf') {
        <app-indicator-runner
          title="ICF — Índice de Cumplimiento de Frecuencia"
          subtitle="Compara las expediciones observadas contra las frecuencias exigidas (A1) por servicio, sentido, período y tipo de día."
          endpoint="/api/icf"
          runLabel="Calcular ICF"
          [showEmpresa]="true"
          [fields]="icfFields"
        />
      } @else if (activeTab() === 'ip') {
        <app-indicator-runner
          title="IP — Índice de Puntualidad"
          subtitle="Compara la hora de pasada observada contra la programada (A5) en cada punto de control. Suba las expediciones del mes y el A5 vigente."
          endpoint="/api/ip"
          runLabel="Calcular IP"
          [showEmpresa]="true"
          [fields]="ipFields"
        />
      } @else if (activeTab() === 'ir') {
        <app-indicator-runner
          title="IR — Índice de Regularidad"
          subtitle="Evalúa la regularidad de los intervalos entre expediciones contra el intervalo exigido, ponderado por punto de control."
          endpoint="/api/ir"
          runLabel="Calcular IR"
          [fields]="irFields"
        />
      }
    </section>
  `,
})
export class ExecutionKpiPage {
  readonly activeTab = signal<KpiTab>('icf');

  readonly tabs: { id: KpiTab; label: string }[] = [
    { id: 'icf', label: 'ICF' },
    { id: 'ip', label: 'IP' },
    { id: 'ir', label: 'IR' },
  ];

  readonly icfFields: RunnerField[] = [
    { name: 'expediciones', label: 'Expediciones del mes', accept: '.xls,.xlsx', icon: 'upload_file', hint: 'Archivo .xls de expediciones observadas (exportado del sistema).' },
    { name: 'frecuencias', label: 'Frecuencias fijas (A1)', accept: '.xlsx', icon: 'schedule', hint: 'Archivo .xlsx con las frecuencias exigidas por período.' },
  ];

  readonly ipFields: RunnerField[] = [
    { name: 'expediciones', label: 'Expediciones del mes', accept: '.xls,.xlsx', icon: 'upload_file', hint: 'Archivo .xls de expediciones observadas (exportado del sistema).' },
    { name: 'a5', label: 'Programación A5', accept: '.xlsx', icon: 'schedule', hint: 'Archivo .xlsx A5 con la Lista de Pasadas Programadas (hoja LPP).' },
  ];

  readonly irFields: RunnerField[] = [
    { name: 'expediciones', label: 'Expediciones / Operación', accept: '.xlsx,.xls', icon: 'upload_file', hint: 'Archivo .xlsx con las expediciones (horas de paso por PC).' },
    { name: 'po', label: 'Programación (PO)', accept: '.xlsx,.xls', icon: 'schedule', hint: 'Archivo .xlsx con la programación de operación (frecuencias).' },
    { name: 'pcir', label: 'Puntos de Control IR', accept: '.xlsx,.xls', icon: 'pin_drop', hint: 'Archivo .xlsx con los puntos de control regulados y sus ponderadores.' },
  ];
}
