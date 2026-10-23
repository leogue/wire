/** The benchmark's design requests, and the parts each schematic must contain to meet its request. */
export interface Task {
  readonly prompt: string;
  /** Required part → a pattern matched against each component's reference, value, symbol and footprint. */
  readonly parts: Readonly<Record<string, RegExp>>;
}

const JLC = 'Utilise des composants disponibles chez JLCPCB si possible, en privilégiant les composants Basic.';

export const TASKS: Readonly<Record<string, Task>> = {
  ldo: {
    prompt: [
      "Design une petite carte d'alimentation : un régulateur 3,3 V AP2112K-3.3 alimenté en 5 V par un connecteur 2 broches,",
      'avec ses condensateurs, une LED témoin sur le 5 V et une autre sur le 3,3 V, et un connecteur de sortie 2 broches.',
    ].join(' '),
    parts: { AP2112K: /AP2112/i, LED: /LED/i },
  },
  'air-quality': {
    prompt: [
      "Design un capteur de qualité de l'air connecté en Wi-Fi qui mesure le CO₂, la température, l'humidité et la pression.",
      'Utilise un ESP32-S3-WROOM-1 comme microcontrôleur, un capteur SCD41 pour le CO₂ et un BME280 pour la température, l\'humidité et la pression, tous les deux en I2C.',
      'Ajoute un connecteur 4 broches pour un petit écran OLED I2C (SSD1306, 3,3 V).',
      'La carte est alimentée en 5 V par un connecteur USB-C, avec un régulateur 3,3 V AP2112K-3.3 et le découplage nécessaire.',
      "Utilise l'USB natif de l'ESP32-S3 pour la programmation, et ajoute les boutons BOOT et RESET.",
      "Ajoute les résistances de pull-up I2C, une LED d'état et le découplage recommandé par les datasheets.",
      JLC,
    ].join('\n'),
    parts: { 'ESP32-S3-WROOM-1': /ESP32-?S3/i, SCD41: /SCD4/i, BME280: /BME280/i, AP2112K: /AP2112/i, 'USB-C': /USB.?C|Type.?C/i },
  },
  powerbank: {
    prompt: [
      'Design une batterie externe (power bank) pour une cellule Li-ion 18650.',
      "Utilise un IP5306 pour la charge de la batterie et la conversion boost en 5 V, avec son inductance et ses condensateurs selon le schéma d'application du datasheet.",
      'Ajoute une protection de cellule avec un DW01A et un double MOSFET FS8205A.',
      "L'entrée de charge se fait par un connecteur USB-C (5 V), et la sortie par un connecteur USB-A femelle.",
      "Ajoute 4 LEDs d'indication du niveau de charge et un bouton marche/arrêt, comme prévu par l'IP5306.",
      JLC,
    ].join('\n'),
    parts: { IP5306: /IP5306/i, DW01A: /DW01/i, FS8205A: /8205/i, 'USB-C': /USB.?C|Type.?C/i, 'USB-A': /USB.?A/i },
  },
  expresslrs: {
    prompt: [
      'Design un receiver pour mon drone qui fonctionne avec le protocole ExpressLRS en 2,4 GHz avec un ESP32-C3 et un SX1280.',
      'Utilise directement le SX1280IMLTRT comme transceiver RF, sans utiliser de module radio préassemblé type E28 ou équivalent.',
      'Utilise un ESP32-C3-WROOM-02 pour le microcontrôleur.',
      'Intègre tous les composants nécessaires autour du SX1280 : alimentation et découplage, quartz 52 MHz, réseau d’adaptation RF / filtre 2,4 GHz, sortie 50 Ω et connecteur U.FL pour l’antenne.',
      'Le receiver doit communiquer avec le flight controller en CRSF UART 3,3 V et être alimenté en 5 V, avec régulation 3,3 V sur la carte.',
      "Ajoute les circuits nécessaires pour le boot, reset et programmation de l’ESP32-C3.",
      JLC,
    ].join('\n'),
    parts: { 'ESP32-C3-WROOM-02': /ESP32-?C3/i, SX1280: /SX1280/i, 'Quartz 52 MHz': /52\s*M/i, 'U.FL': /U\.?FL|IPEX|Coax/i },
  },
};

/** Both runs are unattended: nobody answers questions. */
export const UNATTENDED = 'Travaille sans poser de question et sans t\'arrêter avant le résultat final : personne ne te répondra.';

/** What the baseline is told: deliver a KiCad project and check it with KiCad, with the same tools wire uses. */
export function baselineBrief(kicadCli: string, symbols: string | undefined): string {
  return [
    'Livre le schéma sous forme de projet KiCad 10 dans out/ : un fichier .kicad_pro et son .kicad_sch (une ou plusieurs feuilles).',
    `kicad-cli est installé (${kicadCli}) : vérifie le schéma avec \`kicad-cli sch erc\` et corrige-le jusqu'à 0 erreur.`,
    symbols ? `Les symboles KiCad sont dans ${symbols} (un fichier .kicad_sym par librairie).` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
