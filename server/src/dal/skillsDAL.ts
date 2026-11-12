import { query } from "../config/db.js";
import { ISkill } from "../models/schemas/skill.js";

export const findAll = async (): Promise<ISkill[]> => {
  return query<ISkill>(`SELECT id AS "_id", name FROM skills ORDER BY name`);
};
