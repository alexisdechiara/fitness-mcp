// Official mapping published at https://my.lyfta.app/community/api#exercise-id-mappings.
export const LYFTA_MUSCLES: Readonly<Record<string, string>> = {
  "2": "Adductor Longus",
  "3": "Adductor Magnus",
  "4": "Biceps Brachii",
  "5": "Brachialis",
  "6": "Brachioradialis",
  "7": "Deep Hip External Rotators",
  "8": "Deltoid Anterior",
  "9": "Deltoid Lateral",
  "10": "Deltoid Posterior",
  "11": "Erector Spinae",
  "12": "Gastrocnemius",
  "13": "Gluteus Maximus",
  "14": "Gluteus Medius",
  "15": "Gluteus Minimus",
  "16": "Gracilis",
  "17": "Hamstrings",
  "18": "Iliopsoas",
  "19": "Infraspinatus",
  "20": "Latissimus Dorsi",
  "21": "Levator Scapulae",
  "22": "Obliques",
  "23": "Pectineous",
  "24": "Pectoralis Major Clavicular Head",
  "25": "Pectoralis Major Sternal Head",
  "26": "Popliteus",
  "27": "Quadriceps",
  "28": "Rectus Abdominis",
  "29": "Sartorius",
  "30": "Serratus Ante",
  "31": "Serratus Anterior",
  "32": "Soleus",
  "33": "Splenius",
  "34": "Sternocleidomastoid",
  "35": "Subscapularis",
  "36": "Tensor Fasciae Latae",
  "37": "Teres Major",
  "38": "Teres Minor",
  "39": "Tibialis Anterior",
  "40": "Transverse Abdominis",
  "41": "Trapezius Lower Fibers",
  "42": "Trapezius Middle Fibers",
  "43": "Trapezius Upper Fibers",
  "44": "Triceps Brachii",
  "45": "Wrist Extensors",
  "46": "Wrist Flexors",
};

export function parseLyftaIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string" || typeof entry === "number").map(String);
  }
  if (typeof value !== "string" || value === "null" || value.trim() === "") return [];
  try {
    return parseLyftaIds(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

export function muscleLabel(id: string): string {
  return LYFTA_MUSCLES[id] ?? `muscle_id:${id}`;
}
