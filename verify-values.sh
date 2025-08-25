#!/bin/bash

echo "🔍 Verificando valores en el código..."
echo ""

echo "📋 Buscando bpm: 0..."
grep -n "bpm: 0" src/hooks/useHeartBeatProcessor.ts 2>/dev/null || echo "✅ No hay bpm: 0 en useHeartBeatProcessor.ts"
grep -n "bpm: 0" src/modules/HeartBeatProcessor.ts 2>/dev/null || echo "✅ No hay bpm: 0 en HeartBeatProcessor.ts"

echo ""
echo "📋 Buscando spo2: 0..."
grep -n "spo2: 0" src/pages/Index.tsx 2>/dev/null || echo "✅ No hay spo2: 0 en Index.tsx"
grep -n "spo2: 0" src/modules/vital-signs/VitalSignsProcessor.ts 2>/dev/null || echo "✅ No hay spo2: 0 en VitalSignsProcessor.ts"

echo ""
echo "📋 Verificando archivos..."
[ -f "src/utils/performance-optimization.ts" ] && echo "❌ performance-optimization.ts existe" || echo "✅ performance-optimization.ts NO existe"

echo ""
echo "📋 Valores actuales en useHeartBeatProcessor.ts línea 58:"
sed -n '58p' src/hooks/useHeartBeatProcessor.ts

echo ""
echo "📋 Valores actuales en HeartBeatProcessor.ts línea 296:"
sed -n '296p' src/modules/HeartBeatProcessor.ts

echo ""
echo "📋 Valores actuales en Index.tsx línea 19:"
sed -n '19p' src/pages/Index.tsx

echo ""
echo "📋 Valores actuales en Index.tsx línea 292:"
sed -n '292p' src/pages/Index.tsx