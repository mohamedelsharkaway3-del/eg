// Supabase Edge Function: face-search
// انسخ هذا الكود كاملاً في Edge Function على Supabase
// ══════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supa = createClient(supabaseUrl, supabaseKey)

    const formData = await req.formData()
    const file = formData.get('photo') as File

    if (!file) {
      return new Response(
        JSON.stringify({ error: 'الرجاء رفع صورة' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // تحويل الصورة إلى base64
    const bytes = await file.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
    const mimeType = file.type || 'image/jpeg'

    // ── استخدام Claude Vision للتحقق من وجود وجه بشري ──
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 }
            },
            {
              type: 'text',
              text: 'هل توجد وجوه بشرية واضحة في هذه الصورة؟ أجب بـ YES أو NO فقط.'
            }
          ]
        }]
      })
    })

    const claudeData = await claudeRes.json()
    const answer = claudeData.content?.[0]?.text?.trim().toUpperCase() || 'NO'

    if (!answer.includes('YES')) {
      return new Response(
        JSON.stringify({
          found: false,
          faceDetected: false,
          message: 'لم يتم التعرف على وجه واضح في الصورة. الرجاء رفع صورة شخصية واضحة للوجه.'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── جلب صور الرحلات من قاعدة البيانات ──
    const { data: photos, error: photosErr } = await supa
      .from('trip_photos')
      .select(`
        id,
        public_url,
        caption,
        client_name,
        trip_name,
        trip_date
      `)
      .order('created_at', { ascending: false })
      .limit(100)

    if (photosErr || !photos?.length) {
      return new Response(
        JSON.stringify({
          found: false,
          faceDetected: true,
          message: 'لم يتم رفع صور الرحلات بعد. تواصل مع الشركة للحصول على صورك.',
          hint: 'admin'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── مطابقة الوجه مع صور الرحلات ──
    // نبعت الصورة المرفوعة + صور الرحلات لـ Claude ليقارن
    // نعمل batch بحد أقصى 5 صور في كل مرة
    const matchedPhotos: any[] = []
    const batchSize = 5

    for (let i = 0; i < Math.min(photos.length, 30); i += batchSize) {
      const batch = photos.slice(i, i + batchSize)

      // للصور اللي عندها URL فقط
      const urlPhotos = batch.filter(p => p.public_url)
      if (!urlPhotos.length) continue

      const matchRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64 }
              },
              {
                type: 'text',
                text: `هذه صورة شخصية لشخص يبحث عن صوره. 
أرقام الصور المتاحة للمقارنة: ${urlPhotos.map((_,idx)=>idx+1).join(', ')}.
URLs: ${urlPhotos.map(p=>p.public_url).join(' | ')}

هل الشخص في الصورة الأولى يظهر في أي من هذه الصور؟ 
أجب بالأرقام فقط مثل: 1,3 أو NO إذا لم يوجد.`
              }
            ]
          }]
        })
      })

      const matchData = await matchRes.json()
      const matchAnswer = matchData.content?.[0]?.text?.trim() || 'NO'

      if (!matchAnswer.includes('NO')) {
        const matchedNums = matchAnswer.match(/\d+/g) || []
        matchedNums.forEach((numStr: string) => {
          const idx = parseInt(numStr) - 1
          if (urlPhotos[idx]) matchedPhotos.push(urlPhotos[idx])
        })
      }
    }

    if (matchedPhotos.length === 0) {
      return new Response(
        JSON.stringify({
          found: false,
          faceDetected: true,
          message: 'لم نجد صورك في رحلاتنا المحفوظة. تأكد أنك سافرت معنا أو تواصل مع الشركة.'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        found: true,
        count: matchedPhotos.length,
        photos: matchedPhotos.map(p => ({
          id: p.id,
          url: p.public_url,
          caption: p.caption || '',
          trip: p.trip_name || 'رحلة سابقة',
          date: p.trip_date || '',
          client: p.client_name || ''
        }))
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    console.error('Edge Function Error:', err)
    return new Response(
      JSON.stringify({ error: 'خطأ في الخادم: ' + err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
