import React from 'react';
import { OFFICIAL_TTR_BENCHMARKS, TTR_AVERAGE_BENCHMARK } from '../shared/benchmarks';

export const BenchmarksView: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-8 py-8 flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Procedural Calibration & Board Research
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          To keep procedurally generated maps balanced and faithful to classic tabletop pacing, default targets are calibrated against six major official Ticket to Ride editions.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="text-xs text-slate-500">Target Locations Average</div>
          <div className="text-3xl font-bold font-mono-num text-slate-900 mt-1">
            {TTR_AVERAGE_BENCHMARK.cities}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Range 35–51 stops · Spatial grid + anti-clustering spacing
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="text-xs text-slate-500">Target Routes Average</div>
          <div className="text-3xl font-bold font-mono-num text-slate-900 mt-1">
            {TTR_AVERAGE_BENCHMARK.routes}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Default 2–6 connections per node (tunable 1–10)
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="text-xs text-slate-500">Target Track Spaces Average</div>
          <div className="text-3xl font-bold font-mono-num text-slate-900 mt-1">
            {TTR_AVERAGE_BENCHMARK.spaces}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            Supports 45 trains fixed or proportional to board size
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-left border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
              <th className="py-3 px-4 font-semibold">Edition</th>
              <th className="py-3 px-4 font-semibold">Region</th>
              <th className="py-3 px-4 font-semibold text-right">Locations</th>
              <th className="py-3 px-4 font-semibold text-right">Routes</th>
              <th className="py-3 px-4 font-semibold text-right">Board Spaces</th>
              <th className="py-3 px-4 font-semibold text-right">Player Trains</th>
              <th className="py-3 px-4 font-semibold text-right">Players</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {OFFICIAL_TTR_BENCHMARKS.map((b) => (
              <tr key={b.name} className="hover:bg-slate-50">
                <td className="py-3 px-4 font-semibold text-slate-900">{b.name}</td>
                <td className="py-3 px-4 text-slate-600">{b.region}</td>
                <td className="py-3 px-4 text-right font-mono-num">{b.cities}</td>
                <td className="py-3 px-4 text-right font-mono-num">{b.routes}</td>
                <td className="py-3 px-4 text-right font-mono-num">{b.spaces}</td>
                <td className="py-3 px-4 text-right font-mono-num">{b.trainsPerPlayer}</td>
                <td className="py-3 px-4 text-right font-mono-num">{b.players}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-slate-700">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-bold text-slate-900 mb-2">Multi-Scale Popularity & Hotspot Data</h2>
          <p className="leading-relaxed">
            At continental or national zoom, OpenStreetMap population tags, capital indicators, and IATA airports establish node priority. When zoomed into a single city, Wikipedia GeoSearch cross-references multi-language sitelink counts alongside OSM tourism, monument, and rapid-transit hub tags so iconic landmarks surface without clustering.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-bold text-slate-900 mb-2">Transit Alignment, Crossings & Maritime Hazards</h2>
          <p className="leading-relaxed">
            Routes score alignment against Overpass rail, subway, tram, ferry, and bus relations (weighting express/high-frequency intervals higher). Bus lines can cross at 45° with yellow 1–4 collision triangles derived from road-intersection density, while ferry lanes cross shipping hazards—resolved live with a d6 roll.
          </p>
        </div>
      </div>
    </div>
  );
};
