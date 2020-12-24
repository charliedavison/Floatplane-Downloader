import prompts from "prompts";

/**
 * Prompts if user wants to save their login details.
 * @param {boolean} initial Default value
 * @returns {Promise<boolean>} True or False
 */
export const saveLoginDetails = async (initial: boolean=false): Promise<boolean> => (await prompts({
	type: "toggle",
	name: "save",
	message: "Save your login details?",
	initial,
	active: "Yes",
	inactive: "No"
})).save||initial;

/**
 * Prompts user if they want to find the closest download server now.
 * @param {boolean} initial Default value
 * @returns {Promise<boolean>} True or False
 */
export const findClosestServerNow = async (initial: boolean=true): Promise<boolean> => (await prompts({
	type: "toggle",
	name: "findBestServer",
	message: "Would you like to try find the best download server?",
	initial,
	active: "Yes",
	inactive: "No"
})).findBestServer||initial;