"""ETL headless: GTFS Schedule (.zip) -> matriz 'inputurística' -> encadena heuristica_POs_USs_2026.py.

Fase 1 (solo GTFS Schedule, sin Real Time): cada ruta GTFS (route_id) se trata
como una unidad de servicio con una sola línea (simplificación deliberada;
agrupar varias líneas bajo una misma unidad de servicio requeriría un mapeo
de negocio que el GTFS no provee).
"""
import json
import os
import re
import sys
import subprocess
import unicodedata
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ASINT_HEADLESS = bool(os.environ.get('ASINT_HEADLESS'))

DIAS_SEMANA = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
LABORALES = DIAS_SEMANA[0:5]
TIPOS_DIA = ['Lab', 'Sab', 'Dom']
SENTIDOS = ['ida', 'regreso']
SCRIPT_DIR = Path(__file__).resolve().parent
HEURISTICA_SCRIPT = SCRIPT_DIR / 'heuristica_POs_USs_2026.py'


# --------------------------------------------------------------------------
# Lectura del GTFS
# --------------------------------------------------------------------------
def leer_gtfs(zip_path, columnas_por_archivo):
    tablas = {}
    with zipfile.ZipFile(zip_path) as zf:
        nombres = {os.path.basename(n).lower(): n for n in zf.namelist()}
        requeridos = ['routes.txt', 'trips.txt', 'stop_times.txt']
        faltantes = [r for r in requeridos if r not in nombres]
        if faltantes:
            raise ValueError(
                f"El GTFS no contiene los archivos requeridos: {', '.join(faltantes)}"
            )
        for clave, columnas in columnas_por_archivo.items():
            if clave not in nombres:
                continue
            with zf.open(nombres[clave]) as f:
                tablas[clave] = pd.read_csv(
                    f, dtype=str, low_memory=False, usecols=columnas,
                ) if columnas else pd.read_csv(f, dtype=str, low_memory=False)
    return tablas


def _columnas_disponibles(zip_path, nombre_archivo):
    with zipfile.ZipFile(zip_path) as zf:
        nombres = {os.path.basename(n).lower(): n for n in zf.namelist()}
        if nombre_archivo not in nombres:
            return set()
        with zf.open(nombres[nombre_archivo]) as f:
            cabecera = pd.read_csv(f, dtype=str, nrows=0)
        return set(cabecera.columns)


def _usecols(disponibles, deseadas):
    cols = [c for c in deseadas if c in disponibles]
    return cols if cols else None


def _hms_a_segundos(serie):
    partes = serie.astype(str).str.split(':', expand=True)
    if partes.shape[1] < 3:
        return pd.Series(np.nan, index=serie.index)
    h = pd.to_numeric(partes[0], errors='coerce')
    m = pd.to_numeric(partes[1], errors='coerce')
    s = pd.to_numeric(partes[2], errors='coerce')
    return h * 3600 + m * 60 + s


# --------------------------------------------------------------------------
# Clasificación de tipo de día (Lab/Sab/Dom) por service_id
# --------------------------------------------------------------------------
def clasificar_tipo_dia(tablas):
    resultado = {}

    calendar = tablas.get('calendar.txt')
    if calendar is not None and len(calendar) > 0:
        for _, row in calendar.iterrows():
            sid = row['service_id']
            tipos = set()
            if any(str(row.get(d, '0')).strip() == '1' for d in LABORALES):
                tipos.add('Lab')
            if str(row.get('saturday', '0')).strip() == '1':
                tipos.add('Sab')
            if str(row.get('sunday', '0')).strip() == '1':
                tipos.add('Dom')
            if tipos:
                resultado[sid] = tipos

    # calendar_dates.txt solo se usa como respaldo para service_id que
    # calendar.txt no clasificó (feeds "exception-only", sin calendar.txt).
    calendar_dates = tablas.get('calendar_dates.txt')
    if calendar_dates is not None and len(calendar_dates) > 0:
        pendientes = calendar_dates[~calendar_dates['service_id'].isin(resultado.keys())].copy()
        pendientes = pendientes[pendientes['exception_type'].astype(str) == '1']
        if len(pendientes) > 0:
            fechas = pd.to_datetime(pendientes['date'], format='%Y%m%d', errors='coerce')
            pendientes['dow'] = fechas.dt.dayofweek  # 0=lunes ... 6=domingo
            for sid, grupo in pendientes.dropna(subset=['dow']).groupby('service_id'):
                tipos = set()
                if (grupo['dow'] <= 4).any():
                    tipos.add('Lab')
                if (grupo['dow'] == 5).any():
                    tipos.add('Sab')
                if (grupo['dow'] == 6).any():
                    tipos.add('Dom')
                if tipos:
                    resultado[sid] = tipos

    return resultado


# --------------------------------------------------------------------------
# Distancia por trip_id, en km. Prioridad: shapes (geometría, sin ambigüedad
# de unidades) -> shape_dist_traveled de stop_times (unidad heurística) ->
# distancia secuencial entre paradas (stops.txt).
# --------------------------------------------------------------------------
def _haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2.0) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2.0) ** 2
    return R * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def _longitud_shapes_km(shapes):
    s = shapes.copy()
    s['shape_pt_sequence'] = pd.to_numeric(s['shape_pt_sequence'], errors='coerce')
    s['shape_pt_lat'] = pd.to_numeric(s['shape_pt_lat'], errors='coerce')
    s['shape_pt_lon'] = pd.to_numeric(s['shape_pt_lon'], errors='coerce')
    s = s.dropna(subset=['shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'])
    s = s.sort_values(['shape_id', 'shape_pt_sequence'])
    s['lat_prev'] = s.groupby('shape_id')['shape_pt_lat'].shift()
    s['lon_prev'] = s.groupby('shape_id')['shape_pt_lon'].shift()
    tramo = _haversine_km(s['lat_prev'], s['lon_prev'], s['shape_pt_lat'], s['shape_pt_lon'])
    s['tramo_km'] = tramo.fillna(0)
    return s.groupby('shape_id')['tramo_km'].sum()


def _longitud_stops_secuencial_km(stop_times, stops):
    st = stop_times[['trip_id', 'stop_id', 'stop_sequence']].copy()
    st['stop_sequence'] = pd.to_numeric(st['stop_sequence'], errors='coerce')
    st = st.dropna(subset=['stop_sequence']).sort_values(['trip_id', 'stop_sequence'])
    coords = stops[['stop_id', 'stop_lat', 'stop_lon']].copy()
    coords['stop_lat'] = pd.to_numeric(coords['stop_lat'], errors='coerce')
    coords['stop_lon'] = pd.to_numeric(coords['stop_lon'], errors='coerce')
    st = st.merge(coords, on='stop_id', how='left')
    st['lat_prev'] = st.groupby('trip_id')['stop_lat'].shift()
    st['lon_prev'] = st.groupby('trip_id')['stop_lon'].shift()
    tramo = _haversine_km(st['lat_prev'], st['lon_prev'], st['stop_lat'], st['stop_lon'])
    st['tramo_km'] = tramo.fillna(0)
    return st.groupby('trip_id')['tramo_km'].sum()


def calcular_distancia_por_trip_km(tablas, trips):
    shapes = tablas.get('shapes.txt')
    if shapes is not None and len(shapes) > 0 and 'shape_id' in trips.columns and trips['shape_id'].notna().any():
        long_shape_km = _longitud_shapes_km(shapes)
        dist = trips['shape_id'].map(long_shape_km)
        dist.index = trips['trip_id']
        if dist.notna().any():
            return dist, 'shapes.txt (geometría)'

    stop_times = tablas['stop_times.txt']
    if 'shape_dist_traveled' in stop_times.columns:
        sdt = pd.to_numeric(stop_times['shape_dist_traveled'], errors='coerce')
        maximos = sdt.groupby(stop_times['trip_id']).max()
        if maximos.notna().any():
            # Heurística de unidad: rutas urbanas rara vez superan 300 km;
            # si el máximo observado supera eso, se asume que viene en metros.
            factor = 1.0 if maximos.dropna().median() <= 300 else 1.0 / 1000.0
            return maximos * factor, 'stop_times.shape_dist_traveled (heurística de unidad)'

    stops = tablas.get('stops.txt')
    if stops is not None:
        return _longitud_stops_secuencial_km(stop_times, stops), 'stops.txt (secuencial, línea recta entre paradas)'

    raise ValueError('El GTFS no trae shapes.txt, shape_dist_traveled ni stops.txt: no se puede estimar distancia.')


# --------------------------------------------------------------------------
# Departures sintéticas desde frequencies.txt (trips por headway, no listados
# individualmente en stop_times).
# --------------------------------------------------------------------------
def expandir_frequencies(frequencies):
    f = frequencies.copy()
    f['inicio_s'] = _hms_a_segundos(f['start_time'])
    f['fin_s'] = _hms_a_segundos(f['end_time'])
    f['headway_s'] = pd.to_numeric(f['headway_secs'], errors='coerce')
    f = f.dropna(subset=['inicio_s', 'fin_s', 'headway_s'])
    f = f[f['headway_s'] > 0]

    filas = []
    for _, row in f.iterrows():
        t = row['inicio_s']
        while t < row['fin_s']:
            filas.append({'trip_id': row['trip_id'], 'salida_s': t})
            t += row['headway_s']
    return pd.DataFrame(filas)


# --------------------------------------------------------------------------
# Nombres de hoja de Excel (máx 31 chars, sin : \ / ? * [ ])
# --------------------------------------------------------------------------
def sanitizar_nombre(nombre, largo_max, ocupados):
    nombre = unicodedata.normalize('NFKD', str(nombre)).encode('ascii', 'ignore').decode('ascii')
    nombre = re.sub(r'[:\\/?*\[\]]', '_', nombre).strip() or 'RUTA'
    nombre = nombre[:largo_max]
    base = nombre
    i = 1
    while nombre in ocupados:
        sufijo = f'_{i}'
        nombre = base[: largo_max - len(sufijo)] + sufijo
        i += 1
    ocupados.add(nombre)
    return nombre


# --------------------------------------------------------------------------
# GeoJSON de las rutas procesadas (para el mapa del frontend). Simplifica cada
# trazado con Ramer-Douglas-Peucker en un plano local (metros) para no mandar
# al navegador miles de puntos por shape sin que se note la diferencia visual.
# --------------------------------------------------------------------------
PALETA_COLORES = ['#1A3A6B', '#2E7D32', '#C62828', '#6A1B9A', '#EF6C00', '#00838F', '#AD1457', '#4527A0', '#2F855A', '#B71C1C']


def _proyectar_xy_m(lat, lon, lat0):
    R = 6371000.0
    x = np.radians(lon) * R * np.cos(np.radians(lat0))
    y = np.radians(lat) * R
    return np.column_stack([x, y])


def _rdp_indices(xy, tolerancia_m):
    n = len(xy)
    if n < 3:
        return list(range(n))
    keep = np.zeros(n, dtype=bool)
    keep[0] = True
    keep[-1] = True
    pila = [(0, n - 1)]
    while pila:
        i, j = pila.pop()
        if j <= i + 1:
            continue
        start, end = xy[i], xy[j]
        seg = end - start
        seg_len = float(np.hypot(*seg))
        sub = xy[i + 1:j]
        diff = sub - start
        if seg_len == 0:
            dists = np.hypot(*diff.T)
        else:
            # Producto cruz 2D manual (ax*by - ay*bx): np.cross con vectores de
            # 2 componentes está deprecado desde NumPy 2.0.
            cruz_z = seg[0] * diff[:, 1] - seg[1] * diff[:, 0]
            dists = np.abs(cruz_z) / seg_len
        k_rel = int(np.argmax(dists))
        if dists[k_rel] > tolerancia_m:
            k = i + 1 + k_rel
            keep[k] = True
            pila.append((i, k))
            pila.append((k, j))
    return np.nonzero(keep)[0].tolist()


def _simplificar_polilinea(lats, lons, tolerancia_m=15.0):
    lats = np.asarray(lats, dtype=float)
    lons = np.asarray(lons, dtype=float)
    if len(lats) < 2:
        return []
    if len(lats) < 3:
        return list(zip(lons.tolist(), lats.tolist()))
    xy = _proyectar_xy_m(lats, lons, float(np.mean(lats)))
    idx = _rdp_indices(xy, tolerancia_m)
    return [(float(lons[i]), float(lats[i])) for i in idx]


def construir_geojson_rutas(tablas, trips, routes, rutas_a_procesar, nombres_hoja):
    shapes_por_id = {}
    shapes = tablas.get('shapes.txt')
    if shapes is not None and len(shapes) > 0:
        s = shapes.copy()
        s['shape_pt_sequence'] = pd.to_numeric(s['shape_pt_sequence'], errors='coerce')
        s['shape_pt_lat'] = pd.to_numeric(s['shape_pt_lat'], errors='coerce')
        s['shape_pt_lon'] = pd.to_numeric(s['shape_pt_lon'], errors='coerce')
        s = s.dropna(subset=['shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon']).sort_values(['shape_id', 'shape_pt_sequence'])
        for shape_id, grupo in s.groupby('shape_id'):
            shapes_por_id[shape_id] = (grupo['shape_pt_lat'].to_numpy(), grupo['shape_pt_lon'].to_numpy())

    stops = tablas.get('stops.txt')
    stops_coords = None
    if stops is not None and len(stops) > 0:
        sc = stops.copy()
        sc['stop_lat'] = pd.to_numeric(sc['stop_lat'], errors='coerce')
        sc['stop_lon'] = pd.to_numeric(sc['stop_lon'], errors='coerce')
        stops_coords = sc.set_index('stop_id')[['stop_lat', 'stop_lon']]
    stop_times = tablas['stop_times.txt']

    features = []
    for i_color, rid in enumerate(rutas_a_procesar):
        fila = routes[routes['route_id'] == rid].iloc[0]
        nombre = fila.get('route_short_name') or fila.get('route_long_name') or rid
        color_gtfs = str(fila.get('route_color') or '').strip()
        color = f'#{color_gtfs}' if color_gtfs and color_gtfs.lower() != 'nan' else PALETA_COLORES[i_color % len(PALETA_COLORES)]

        trips_ruta = trips[trips['route_id'] == rid]
        for sentido in SENTIDOS:
            trips_sentido = trips_ruta[trips_ruta['sentido'] == sentido]
            if len(trips_sentido) == 0:
                continue

            coords = None
            # Geometría representativa: el shape_id más frecuente entre los viajes
            # de esa ruta+sentido (evita dibujar variantes minoritarias/desvíos).
            modas = trips_sentido['shape_id'].mode()
            if len(modas) > 0 and modas.iloc[0] in shapes_por_id:
                lats, lons = shapes_por_id[modas.iloc[0]]
                coords = _simplificar_polilinea(lats, lons)
            elif stops_coords is not None:
                # Sin shapes.txt (o shape_id sin match en él): traza recta entre las
                # paradas del viaje más representativo, en vez de omitir la ruta.
                trip_id_repr = trips_sentido['trip_id'].iloc[0]
                st = stop_times[stop_times['trip_id'] == trip_id_repr].copy()
                st['stop_sequence'] = pd.to_numeric(st['stop_sequence'], errors='coerce')
                st = st.dropna(subset=['stop_sequence']).sort_values('stop_sequence')
                st = st.merge(stops_coords, left_on='stop_id', right_index=True, how='left').dropna(subset=['stop_lat', 'stop_lon'])
                if len(st) >= 2:
                    coords = list(zip(st['stop_lon'].tolist(), st['stop_lat'].tolist()))

            if not coords or len(coords) < 2:
                continue

            features.append({
                'type': 'Feature',
                'properties': {
                    'route_id': str(rid),
                    'unidad_servicio': nombres_hoja[rid],
                    'nombre': str(nombre),
                    'sentido': sentido,
                    'color': color,
                },
                'geometry': {'type': 'LineString', 'coordinates': coords},
            })

    return {'type': 'FeatureCollection', 'features': features}


# --------------------------------------------------------------------------
# Construcción de la matriz 'inputurística'. Procesa TODAS las rutas del GTFS
# (sin tope): es solo lectura/agregación de dataframes, barato comparado con
# ejecutar_heuristica_por_unidad (esa sí spawnea un proceso Python por unidad,
# ese es el paso que se acota/pospone hasta que el usuario elige qué correr).
# --------------------------------------------------------------------------
def construir_inputuristica(zip_path):
    columnas = {
        'routes.txt': None,
        'trips.txt': ['trip_id', 'route_id', 'service_id', 'direction_id', 'shape_id'],
        'stop_times.txt': None,  # se decide con _columnas_disponibles/_usecols abajo
        'stops.txt': ['stop_id', 'stop_lat', 'stop_lon'],
        'calendar.txt': None,
        'calendar_dates.txt': ['service_id', 'date', 'exception_type'],
        'shapes.txt': ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'],
        'frequencies.txt': ['trip_id', 'start_time', 'end_time', 'headway_secs'],
    }
    disponibles_st = _columnas_disponibles(zip_path, 'stop_times.txt')
    columnas['stop_times.txt'] = _usecols(
        disponibles_st,
        ['trip_id', 'stop_sequence', 'arrival_time', 'departure_time', 'shape_dist_traveled'],
    )

    tablas = leer_gtfs(zip_path, columnas)
    routes = tablas['routes.txt']
    trips = tablas['trips.txt'].copy()

    if 'shape_id' not in trips.columns:
        trips['shape_id'] = np.nan

    # --- sentido: direction_id 0 -> ida, 1 (o vacío) -> regreso. Se calcula ANTES
    # del explode por tipo de día para poder reusar "trips" (sin duplicar) al
    # elegir la geometría representativa por ruta+sentido (ver construir_geojson_rutas).
    trips['sentido'] = np.where(trips['direction_id'].astype(str) == '0', 'ida', 'regreso')

    # --- tipo de día por trip (explota trips que corren en varios tipos de día) ---
    tipo_dia_por_servicio = clasificar_tipo_dia(tablas)
    if not tipo_dia_por_servicio:
        raise ValueError('No se pudo clasificar ningún service_id en Lab/Sab/Dom (revisa calendar.txt / calendar_dates.txt).')
    trips['tipos_dia'] = trips['service_id'].map(tipo_dia_por_servicio)
    trips_con_dia = trips.dropna(subset=['tipos_dia'])
    trips_expandido = trips_con_dia.explode('tipos_dia').rename(columns={'tipos_dia': 'tipo_dia'})

    # --- primer salida / última llegada por trip ---
    # Solo las columnas que hacen falta aquí (no shape_dist_traveled): stop_times.txt
    # puede tener millones de filas en feeds grandes, y esta función corre en un
    # contenedor con RAM compartida entre Node y Python (Render free = 512 MB).
    st_sorted = tablas['stop_times.txt'][['trip_id', 'stop_sequence', 'arrival_time', 'departure_time']].copy()
    st_sorted['stop_sequence'] = pd.to_numeric(st_sorted['stop_sequence'], errors='coerce')
    st_sorted.sort_values(['trip_id', 'stop_sequence'], inplace=True)
    salida_s = _hms_a_segundos(st_sorted['departure_time'])
    llegada_s = _hms_a_segundos(st_sorted['arrival_time'])
    st_sorted.drop(columns=['arrival_time', 'departure_time'], inplace=True)
    st_sorted['salida_s'] = salida_s
    st_sorted['llegada_s'] = llegada_s

    primeras = st_sorted.dropna(subset=['salida_s']).groupby('trip_id')['salida_s'].first()
    ultimas = st_sorted.dropna(subset=['llegada_s']).groupby('trip_id')['llegada_s'].last()
    del st_sorted

    distancia_km, metodo_distancia = calcular_distancia_por_trip_km(tablas, trips)
    print(f'[GTFS] Distancia estimada via: {metodo_distancia}')

    resumen_trip = pd.DataFrame({'salida_s': primeras, 'llegada_s': ultimas, 'distancia_km': distancia_km})
    resumen_trip['duracion_h'] = (resumen_trip['llegada_s'] - resumen_trip['salida_s']) / 3600.0
    resumen_trip['hora'] = ((resumen_trip['salida_s'] // 3600) % 24).astype('Int64')

    # Velocidad = distancia/duración. Solo con datos válidos (evita 0 o negativos);
    # heuristica_POs_USs_2026.py hace dist/vel para las 144 filas SIN filtrar por
    # exp==0, y la división float por 0.0 en Python lanza ZeroDivisionError en
    # tiempo de ejecución (no da inf). Por eso vel nunca puede quedar en 0 exacto.
    valido = (resumen_trip['duracion_h'] > 0) & (resumen_trip['distancia_km'] > 0)
    resumen_trip.loc[valido, 'velocidad_kmh'] = resumen_trip.loc[valido, 'distancia_km'] / resumen_trip.loc[valido, 'duracion_h']

    trips_expandido = trips_expandido.merge(resumen_trip, left_on='trip_id', right_index=True, how='left')
    trips_expandido = trips_expandido.dropna(subset=['hora'])

    # --- conteo de salidas por hora: reemplaza trips con patrón frequencies.txt
    # por sus salidas sintéticas (uno o más departures por hora según headway) ---
    frequencies = tablas.get('frequencies.txt')
    conteo_base = trips_expandido[['trip_id', 'route_id', 'sentido', 'tipo_dia', 'hora']].copy()
    conteo_base['peso'] = 1

    if frequencies is not None and len(frequencies) > 0:
        sinteticas = expandir_frequencies(frequencies)
        if len(sinteticas) > 0:
            sinteticas['hora'] = ((sinteticas['salida_s'] // 3600) % 24).astype('Int64')
            meta = trips_expandido[['trip_id', 'route_id', 'sentido', 'tipo_dia']].drop_duplicates('trip_id')
            sinteticas = sinteticas.merge(meta, on='trip_id', how='inner')
            sinteticas['peso'] = 1
            conteo_base = conteo_base[~conteo_base['trip_id'].isin(sinteticas['trip_id'].unique())]
            conteo_base = pd.concat(
                [conteo_base, sinteticas[['trip_id', 'route_id', 'sentido', 'tipo_dia', 'hora', 'peso']]],
                ignore_index=True,
            )

    exp_por_grupo = conteo_base.groupby(['route_id', 'sentido', 'tipo_dia', 'hora'])['peso'].sum()

    # dist/vel representativos por (ruta, sentido, tipo_dia): mediana, para no
    # distorsionar por outliers (viajes con datos GPS/horario atípicos).
    validos_trip = trips_expandido.drop_duplicates('trip_id')
    agg = validos_trip.groupby(['route_id', 'sentido', 'tipo_dia']).agg(
        dist_km=('distancia_km', 'median'),
        vel_kmh=('velocidad_kmh', 'median'),
        n_trips=('trip_id', 'count'),
    )
    # Grupos sin dato propio (p.ej. una ruta sin servicio de fin de semana) heredan
    # la mediana global de la ruta; si tampoco existe, quedan en blanco (NaN es
    # seguro: la división por NaN no revienta, a diferencia de la división por 0).
    dist_ruta = validos_trip.groupby('route_id')['distancia_km'].median()
    vel_ruta = validos_trip.groupby('route_id')['velocidad_kmh'].median()

    routes_id = routes['route_id'].tolist()
    nombres_hoja = {}
    ocupados = set()
    for rid in routes_id:
        fila = routes[routes['route_id'] == rid].iloc[0]
        etiqueta = fila.get('route_short_name') or fila.get('route_long_name') or rid
        # Prefijo "R" obligatorio: heuristica_POs_USs_2026.py lee 'Licitaciones_líneas'
        # con pd.read_excel sin dtype fijo, así que una 'unidad de servicio' puramente
        # numérica (típico en códigos de ruta GTFS, ej. "705") se infiere como int64;
        # luego la compara contra el nombre de hoja (siempre str) y nunca coincide
        # (IndexError: 'proceso'.unique()[0] con size 0). El prefijo evita que la
        # columna sea 100% numérica y por lo tanto ese cast automático de pandas.
        nombres_hoja[rid] = sanitizar_nombre(f'R{etiqueta}', 24, ocupados)  # 24 = 31 - len('INPUT_')

    # Orden por cantidad de viajes: sirve para que, si luego el usuario pide
    # "ejecutar TODAS", se prioricen las rutas con más servicio real.
    conteo_trips_por_ruta = validos_trip.groupby('route_id')['trip_id'].nunique().reindex(routes_id).fillna(0)
    rutas_ordenadas = conteo_trips_por_ruta.sort_values(ascending=False).index.tolist()

    licitaciones = pd.DataFrame({
        'unidad de servicio': [nombres_hoja[r] for r in rutas_ordenadas],
        'proceso': 'GTFS',
        'línea': [nombres_hoja[r] for r in rutas_ordenadas],
    })

    hojas_input = {}
    for rid in rutas_ordenadas:
        filas = []
        for tipo_dia in TIPOS_DIA:
            for sentido in SENTIDOS:
                dist_g = agg['dist_km'].get((rid, sentido, tipo_dia), np.nan)
                vel_g = agg['vel_kmh'].get((rid, sentido, tipo_dia), np.nan)
                if pd.isna(dist_g):
                    dist_g = dist_ruta.get(rid, np.nan)
                if pd.isna(vel_g):
                    vel_g = vel_ruta.get(rid, np.nan)
                dist_g = 0.0 if pd.isna(dist_g) else max(float(dist_g), 0.0)
                vel_g = np.nan if (pd.isna(vel_g) or vel_g <= 0) else float(vel_g)
                for hora in range(24):
                    exp_g = int(exp_por_grupo.get((rid, sentido, tipo_dia, hora), 0))
                    filas.append({
                        'día': tipo_dia,
                        'sentido': sentido,
                        'período': hora,
                        'exp': exp_g,
                        'dist': dist_g,
                        'vel': vel_g,
                    })
        hojas_input[nombres_hoja[rid]] = pd.DataFrame(filas)

    geojson_rutas = construir_geojson_rutas(tablas, trips, routes, rutas_ordenadas, nombres_hoja)

    return licitaciones, hojas_input, rutas_ordenadas, nombres_hoja, geojson_rutas, conteo_trips_por_ruta


# --------------------------------------------------------------------------
# Encadenamiento con heuristica_POs_USs_2026.py, una vez por unidad de servicio
# --------------------------------------------------------------------------
def ejecutar_heuristica_por_unidad(inputuristica_path, output_dir, unidades, params_heuristica):
    ok, fallidas = [], []
    for unidad in unidades:
        env = os.environ.copy()
        env.update({
            'ASINT_HEADLESS': '1',
            'ASINT_INPUT_FILE': str(inputuristica_path),
            'ASINT_SHEET_NAME': unidad,
            'ASINT_OUTPUT_DIR': str(output_dir),
            'PYTHONIOENCODING': 'utf-8',
            **params_heuristica,
        })
        print(f'[heurística] Ejecutando unidad de servicio "{unidad}"...')
        resultado = subprocess.run(
            [sys.executable, '-X', 'utf8', str(HEURISTICA_SCRIPT)],
            cwd=str(HEURISTICA_SCRIPT.parent),
            env=env,
            capture_output=True,
            text=True,
            encoding='utf-8',
        )
        if resultado.returncode == 0:
            ok.append(unidad)
        else:
            fallidas.append(unidad)
            print(f'[heurística] FALLÓ "{unidad}" (exit {resultado.returncode}):')
            print(resultado.stderr[-2000:])
    return ok, fallidas


def _previsualizar(output_dir):
    """Solo ETL: parsea el GTFS, arma la matriz 'inputurística' completa (TODAS
    las rutas) y el mapa. No ejecuta heuristica_POs_USs_2026.py todavía — eso
    se pospone a _ejecutar(), una vez que el usuario elige qué correr."""
    input_file = os.environ.get('ASINT_INPUT_FILE')
    if not input_file:
        raise ValueError('ASINT_INPUT_FILE (el .zip del GTFS) es obligatorio para previsualizar.')

    print(f'[GTFS] Procesando {input_file}...')
    licitaciones, hojas_input, rutas_ordenadas, nombres_hoja, geojson_rutas, conteo_trips = construir_inputuristica(input_file)
    print(f'[GTFS] {len(rutas_ordenadas)} servicios detectados (rutas GTFS).')

    inputuristica_path = output_dir / 'inputuristica.xlsx'
    with pd.ExcelWriter(inputuristica_path, engine='openpyxl') as writer:
        licitaciones.to_excel(writer, sheet_name='Licitaciones_líneas', index=False)
        for rid in rutas_ordenadas:
            hoja = nombres_hoja[rid]
            hojas_input[hoja].to_excel(writer, sheet_name=f'INPUT_{hoja}', index=False)
    print(f'[GTFS] Matriz "inputurística" escrita en {inputuristica_path}')

    geojson_path = output_dir / 'rutas.geojson'
    with open(geojson_path, 'w', encoding='utf-8') as f:
        json.dump(geojson_rutas, f, ensure_ascii=False)
    print(f'[GTFS] Mapa de rutas escrito en {geojson_path} ({len(geojson_rutas["features"])} trazados).')

    servicios = [
        {
            'unidadServicio': nombres_hoja[rid],
            'sheetName': f'INPUT_{nombres_hoja[rid]}',
            'routeId': str(rid),
            'nTrips': int(conteo_trips.get(rid, 0)),
        }
        for rid in rutas_ordenadas
    ]
    servicios_path = output_dir / 'servicios.json'
    with open(servicios_path, 'w', encoding='utf-8') as f:
        json.dump(servicios, f, ensure_ascii=False)
    print(f'[GTFS] {len(servicios)} servicios listados en {servicios_path}. Elige uno (o todos) para ejecutar la heurística.')


def _ejecutar(output_dir):
    """Corre heuristica_POs_USs_2026.py solo para la selección del usuario,
    reusando la matriz ya construida por una previsualización anterior (no
    vuelve a parsear el .zip GTFS)."""
    inputuristica_path = Path(os.environ.get('ASINT_INPUT_FILE', ''))
    if not inputuristica_path.exists():
        raise ValueError(
            f'No se encontró la matriz "inputurística" de una previsualización previa en {inputuristica_path}. '
            'Corre primero ASINT_TRIPY_ACCION=previsualizar sobre el mismo run.'
        )

    import openpyxl
    wb = openpyxl.load_workbook(inputuristica_path, read_only=True)
    todas_las_hojas = [s for s in wb.sheetnames if s.startswith('INPUT_')]
    wb.close()

    seleccion = os.environ.get('ASINT_UNIDADES', 'TODAS').strip()
    if seleccion == 'TODAS':
        max_rutas = int(os.environ.get('ASINT_MAX_RUTAS', '25'))
        sheet_names = todas_las_hojas[:max_rutas]
        if len(todas_las_hojas) > max_rutas:
            print(
                f'[GTFS] AVISO: se ejecutan {max_rutas} de {len(todas_las_hojas)} servicios detectados '
                f'(tope ASINT_MAX_RUTAS). Omitidas: {todas_las_hojas[max_rutas:]}'
            )
    else:
        pedidos = {s.strip() for s in seleccion.split(',') if s.strip()}
        sheet_names = [s for s in todas_las_hojas if s in pedidos or s.replace('INPUT_', '', 1) in pedidos]
        encontrados = {s.replace('INPUT_', '', 1) for s in sheet_names} | set(sheet_names)
        faltantes = pedidos - encontrados
        if faltantes:
            raise ValueError(f'Servicio(s) no encontrados en la matriz: {sorted(faltantes)}')

    if not sheet_names:
        raise ValueError('ASINT_UNIDADES no seleccionó ningún servicio válido para ejecutar.')

    params_heuristica = {
        'ASINT_HORAS_BLOQUE': os.environ.get('ASINT_HORAS_BLOQUE', '144'),
        'ASINT_HORA_INICIO_BLOQUE': os.environ.get('ASINT_HORA_INICIO_BLOQUE', '0'),
        'ASINT_LIMITE_EXPEDICION': os.environ.get('ASINT_LIMITE_EXPEDICION', '1000'),
        'ASINT_PASO_MINUTOS': os.environ.get('ASINT_PASO_MINUTOS', '5'),
    }
    ok, fallidas = ejecutar_heuristica_por_unidad(inputuristica_path, output_dir, sheet_names, params_heuristica)

    print(f'[RESUMEN] {len(ok)} unidades procesadas OK, {len(fallidas)} fallidas de {len(sheet_names)} solicitadas.')
    if fallidas:
        print(f'[RESUMEN] Unidades fallidas: {fallidas}')
    if not ok:
        raise RuntimeError('Ninguna unidad de servicio pudo procesarse con la heurística.')


def main():
    output_dir = os.environ.get('ASINT_OUTPUT_DIR')
    if not output_dir:
        raise ValueError('ASINT_OUTPUT_DIR es obligatorio (modo headless).')
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    accion = os.environ.get('ASINT_TRIPY_ACCION', 'previsualizar').strip()
    if accion == 'previsualizar':
        _previsualizar(output_dir)
    elif accion == 'ejecutar':
        _ejecutar(output_dir)
    else:
        raise ValueError(f"ASINT_TRIPY_ACCION invalido: '{accion}' (valores validos: previsualizar, ejecutar)")


if __name__ == '__main__':
    main()
