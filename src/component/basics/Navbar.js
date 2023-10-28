import React, { useState } from "react";

const Navbar = ({ filterItem, menuList, sortItems }) => {
  const [popularitySortType, setPopularitySortType] = useState(""); // State for popularity sort type
  const [priceSortType, setPriceSortType] = useState(""); // State for price sort type

  const handlePopularitySortChange = (event) => {
    const selectedSortType = event.target.value;
    setPopularitySortType(selectedSortType);
    sortItems(selectedSortType);
  };

  const handlePriceSortChange = (event) => {
    const selectedSortType = event.target.value;
    setPriceSortType(selectedSortType);
    sortItems(selectedSortType);
  };

  return (
    <>
      <nav className="navbar">
        <div className="btn-group">
          {menuList.map((curElem) => {
            return (
              <button
                className="btn-group__item"
                onClick={() => filterItem(curElem)}
                key={curElem}
              >
                {curElem}
              </button>
            );
          })}
        </div>

        {/* Sort by Popularity Dropdown */}
        <div className="dropdown">
          <button className="dropbtn">Sort by Popularity</button>
          <div className="dropdown-content">
            <select value={popularitySortType} onChange={handlePopularitySortChange}>
              <option value="">Select</option>
              <option value="highToLow">High to Low</option>
              <option value="lowToHigh">Low to High</option>
            </select>
          </div>
        </div>

        {/* Sort by Price Dropdown */}
        <div className="dropdown">
          <button className="dropbtn">Sort by Price</button>
          <div className="dropdown-content">
            <select value={priceSortType} onChange={handlePriceSortChange}>
              <option value="">Select</option>
              <option value="priceHighToLow">High to Low</option>
              <option value="priceLowToHigh">Low to High</option>
            </select>
          </div>
        </div>
      </nav>
    </>
  );
};

export default Navbar;
