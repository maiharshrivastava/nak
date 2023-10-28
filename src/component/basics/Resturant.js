import React, { useState } from "react";
import "./style.css";
import Menu from "./menuApi.js";
import MenuCard from "./MenuCard";
import Navbar from "./Navbar";

const uniqueList = [
  ...new Set(
    Menu.map((curElem) => {
      return curElem.category;
    })
  ),
  "All",
];

const Resturant = () => {
  const [menuData, setMenuData] = useState(Menu);
  const [menuList, setMenuList] = useState(uniqueList);

  const filterItem = (category) => {
    if (category === "All") {
      setMenuData(Menu);
      return;
    }

    const updatedList = Menu.filter((curElem) => {
      return curElem.category === category;
    });

    setMenuData(updatedList);
  };



  const sortItems = (type) => {
    let sortedMenu = [...menuData];
    if (type === "popularity") {
      sortedMenu.sort((a, b) => b.popularity - a.popularity);
    } else if (type === "priceHighToLow") {
      sortedMenu.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    } else if (type === "priceLowToHigh") {
      sortedMenu.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    }
    setMenuData(sortedMenu);
  };

 
  return (
    <>
      <Navbar filterItem={filterItem} menuList={menuList} sortItems={sortItems} />
      <MenuCard menuData={menuData} />
    </>
  );
};

export default Resturant;
